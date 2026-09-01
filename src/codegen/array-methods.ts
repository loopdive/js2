// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Array method compilation — extracted from expressions.ts.
 *
 * All array prototype and functional method implementations live here.
 * This module imports compileExpression and compileArrowAsClosure from
 * shared.ts (NOT expressions.ts) to avoid circular dependencies.
 */
import { ts } from "../ts-api.js";
import { isBooleanType, isStringType, isVoidType } from "../checker/type-mapper.js";
import type { Instr, ValType } from "../ir/types.js";
import { reportError } from "./context/errors.js";
import { allocLocal, allocTempLocal, getLocalType } from "./context/locals.js";
import { probeCompiledType } from "./context/speculative.js";
import { emitHoleToUndefined, holeTestInstrs, holeToUndefinedInstrs, joinEmptyElementTest } from "./array-holes.js";
import { emitF64HoleToUndef, f64HolesActive, f64HoleTestInstrs, f64HoleToUndefFor } from "./vec-f64-hole-presence.js"; // (#4491 T11)
import { overlayRouteActive } from "./typed-lane-overlay-route.js"; // (#4491 T11)
import {
  arraySpeciesActive,
  emitArraySpeciesCreate,
  emitArraySpeciesResultSwap,
  prepareArraySpeciesDeps,
  withArraySpeciesSuppressed,
} from "./array-species.js"; // (#5145) ArraySpeciesCreate + CreateDataPropertyOrThrow
import { f64JoinSentinelArm } from "./vec-f64-hole-gap.js"; // (#4491 T8)
import { HOLE_F64_BITS, UNDEF_F64_BITS } from "./value-tags.js"; // (#4638) concat absent-tail marker
import { buildJoinBoxedElementToString, isAnyStringSubtype } from "./array-join-element.js"; // (#4560)
import type { ClosureInfo, CodegenContext, FunctionContext } from "./context/types.js";
import {
  addArrayIteratorImports,
  addStringImports,
  addUnionImports,
  resolveWasmType,
  resolveWasmTypeForClosureReturn,
  typedArrayPackedSignedness,
} from "./index.js";
import { getClosureFuncSelfTypeIdx, getOrCreateFuncRefWrapperTypes } from "./closures/funcref-wrapper-types.js";
import { getFuncSignature } from "./closures/funcref-wrapper-types.js";
import { addStringConstantGlobal, localGlobalIdx } from "./registry/imports.js";
import { reserveVecMethodHelper } from "./vec-access-exports.js"; // (#4531) extern-receiver push/pop dual-lane
import { buildThrowJsErrorInstrs, emitThrowTypeError, noJsHost } from "./js-errors.js";
import { emitTypedArraySetBoundsCheck } from "./typed-array-set-bounds.js";
import { emitToBoolean } from "./coercion-engine.js";
import { compileStringLiteral, elemGetOp, unpackedElemType, valTypesMatch } from "./shared.js";
import {
  getArrTypeIdxFromVec,
  getOrRegisterArrayType,
  isHoleyArrayType,
  getOrRegisterSubviewType,
  getOrRegisterTaDynViewType,
  getOrRegisterVecType,
  getSubviewArrTypeIdx,
  isTaViewTypeIdx,
} from "./registry/types.js";
import {
  emitTaDynSpeciesCreate,
  pushElemSizeForKind,
  emitTaDynViewToVec,
  emitTaDynViewValidate,
  emitTaDynViewWriteF64Vec,
  emitTaViewToVec,
  emitTaViewValidate,
  emitTaViewWriteBack,
  pushTaViewEffectiveLen,
  taViewDecode,
} from "./dataview-native.js"; // (#3054 B1 Option A) de-view; (B3) write-through; (#3058) dyn-view materialize+validate
import { ensureNativeIteratorRuntime, getOrRegisterIterRecType } from "./iterator-native.js";
import { ensureObjVecBuilders } from "./object-runtime.js";
import { tryEmitProtoOverrideTwoArm } from "./builtin-proto-member-override.js"; // (#4556 bucket A)
import { ensureArgcGlobal, ensureCurrentThisGlobal, ensureExtrasArgvGlobal } from "./statements/nested-declarations.js";
import {
  compileArrowAsClosure,
  compileExpression,
  ensureLateImport,
  flushLateImportShifts,
  registerEmitBoundsCheckedArrayGet,
  VOID_RESULT,
} from "./shared.js";
import { emitIncludesSearchValue, emitIndexOfAbsentSearchValue } from "./array-includes-search-value.js";
import { emitUndefined, ensureGetUndefined } from "./expressions/late-imports.js";
import { ensureExternSameValueZeroHelper, ensureExternStrictEqHelper, undefinedExternInstrs } from "./any-helpers.js";
import {
  ensureNativeStringHelpers,
  nativeStringLiteralInstrs,
  nativeStringType,
  stringConstantExternrefInstrs,
} from "./native-strings.js";
import { emitNativeNumberFormat } from "./number-format-native.js";
import { ensureNativeArrayHof } from "./hof-native.js";
import { flatMapSpeciesResult } from "./array-flatmap.js";
// (§15.4.4.20 / §23.1.3.7) live per-index HasProperty + fresh Get for `filter`.
import { filterSelectStage, overlayFilterAccess } from "./array-filter-spec-access.js";
import { allocJoinFoldLocals, emitStringJoinFold, hostStringRepr, nativeStringRepr } from "./builtin-scaffold.js";
import { ensureTimsortHelper } from "./timsort.js";
import { emitStableMergeSort } from "./merge-sort.js"; // (#3902) shared stable O(n log n) sort skeleton
import {
  buildVecFromExternMaterializer,
  buildVecFromExternref,
  coerceType,
  coercionInstrs,
  defaultValueInstrs,
  emitGuardedRefCast,
} from "./type-coercion.js";
import { staticIntegerRange } from "../ir/analysis/static-numeric-range.js";
import { tryEmitStaticI32Expression } from "./i32-static-range-expr.js";
import { countedPushIndexOfUnroll, emitArrayIndexOfScan } from "./array-indexof-scan.js";
import { compileArrayConcatExternHost, compileArrayMethodExtern } from "./array-method-host.js";
// (#4446) The §23.1.3.1 host-free concat loop for dynamic operands.
import { compileArrayConcatNativeSpec } from "./array-concat-spec.js";
// (#4655) Shared concat carrier/dispatch predicate — see array-concat-carrier.ts.
import { concatMustConsultPrototypeChain } from "./array-concat-carrier.js";
import { ensureJoinProtoHoleLocal, joinProtoHoleFallbackInstrs } from "./array-join-proto-hole.js";
// (#4655) `Array.prototype.toLocaleString`'s element Invoke (§23.1.3.32 6.c.i).
import * as tls from "./array-tolocalestring.js";
const {
  buildExternJoinElementToString,
  elementToLocaleStringTail,
  ensureElementToLocaleStringInvoke,
  isLocalizedJoin,
} = tls;
import { emitFuncRefAsClosure } from "./closures/funcref-as-closure.js";
import { emitRuntimeEvalCarrierUnwrapAny } from "./runtime-eval-callable.js";
import { emitSymbolOperandCoercionThrow } from "./tonumber-symbol-throw.js"; // (#3481)

// (#3264) Array.prototype-borrow subsystem extracted to array-prototype-borrow.ts;
// re-export the two public entries so existing importers keep resolving.
export { compileArrayLikePrototypeCall, compileArrayPrototypeCall } from "./array-prototype-borrow.js";

type ArrayMethodAccess = ts.PropertyAccessExpression | ts.ElementAccessExpression;

/**
 * True for the exact unshadowed builtin `Array.prototype` value used while the
 * realm is still pristine. `Array.prototype` is itself an initially empty
 * Array exotic object, even though standalone represents its general
 * first-class value as `$NativeProto` metadata (#4378).
 */
export function isPristineArrayPrototypeExpression(fctx: FunctionContext, expression: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(expression) &&
    expression.name.text === "prototype" &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === "Array" &&
    !fctx.localMap.has("Array") &&
    !(fctx.boxedCaptures?.has("Array") ?? false)
  );
}

/** Exact `Array.prototype[Symbol.iterator]()` bootstrap shape. */
export function isPristineArrayPrototypeIteratorCall(fctx: FunctionContext, expression: ts.Expression): boolean {
  if (!ts.isCallExpression(expression) || expression.arguments.length !== 0) return false;
  const callee = expression.expression;
  if (!ts.isElementAccessExpression(callee) || !isPristineArrayPrototypeExpression(fctx, callee.expression)) {
    return false;
  }
  const key = callee.argumentExpression;
  return (
    ts.isPropertyAccessExpression(key) &&
    ts.isIdentifier(key.expression) &&
    key.expression.text === "Symbol" &&
    key.name.text === "iterator" &&
    !fctx.localMap.has("Symbol") &&
    !(fctx.boxedCaptures?.has("Symbol") ?? false)
  );
}

/**
 * #2036 — content-equality for native-string array elements in the search
 * methods (`indexOf`/`lastIndexOf`/`includes`).
 *
 * For a `string[]` under native strings the element ValType is a
 * `ref_null $AnyString` (typeIdx === ctx.anyStrTypeIdx). The search loops used
 * `ref.eq` (reference identity) for the `ref`/`ref_null` arm, which is wrong for
 * strings: every string literal/slice materialises a distinct `$AnyString`
 * allocation, so `['a','b','c'].indexOf('c')` and
 * `Array.prototype.indexOf.call(['a','b'], 'b')` returned -1 (and the `any`-vec
 * `__host_eq` stub mismatched the other direction). Strict equality on strings
 * is by content (§7.2.16), so route native-string elements to `__str_equals`
 * (which flattens cons-strings and compares code units) instead.
 *
 * Returns `undefined` when `elemType` is NOT a native-string ref, so the caller
 * keeps its existing `ref.eq` arm for genuine reference elements (objects).
 *
 * The returned Instrs consume TWO operands already on the stack — the element
 * and the search value, both `ref_null $AnyString` — and leave an i32 (0/1).
 * SameValueZero (`includes`) and Strict Equality (`indexOf`/`lastIndexOf`)
 * coincide for strings (no NaN/±0 string subtlety), so one helper serves all
 * three. A null element (array hole / explicit null search value) is handled by
 * a ref.eq fast-path first: null===null → true, null vs a string → false,
 * matching strict-equality semantics without trapping in `__str_equals`.
 */
export function nativeStringElementEqInstrs(
  ctx: CodegenContext,
  fctx: FunctionContext,
  elemType: ValType,
): Instr[] | undefined {
  if (!ctx.nativeStrings || ctx.anyStrTypeIdx < 0) return undefined;
  if (elemType.kind !== "ref" && elemType.kind !== "ref_null") return undefined;
  if (elemType.typeIdx !== ctx.anyStrTypeIdx) return undefined;

  ensureNativeStringHelpers(ctx);
  const strEqIdx = ctx.nativeStrHelpers.get("__str_equals");
  if (strEqIdx === undefined) return undefined;

  const anyStrNull: ValType = { kind: "ref_null", typeIdx: ctx.anyStrTypeIdx };
  const elemTmp = allocLocal(fctx, `__str_eq_el_${fctx.locals.length}`, anyStrNull);
  const valTmp = allocLocal(fctx, `__str_eq_val_${fctx.locals.length}`, anyStrNull);

  // Stack on entry: [elem, val]. Spill val then elem.
  return [
    { op: "local.set", index: valTmp },
    { op: "local.set", index: elemTmp },
    // Null fast-path: if either side is null, equality is ref.eq (null===null
    // → true; null vs string → false). __str_equals would trap on a null param.
    { op: "local.get", index: elemTmp },
    { op: "ref.is_null" },
    { op: "local.get", index: valTmp },
    { op: "ref.is_null" },
    { op: "i32.or" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [{ op: "local.get", index: elemTmp }, { op: "local.get", index: valTmp }, { op: "ref.eq" }],
      else: [
        { op: "local.get", index: elemTmp },
        { op: "ref.as_non_null" },
        { op: "local.get", index: valTmp },
        { op: "ref.as_non_null" },
        { op: "call", funcIdx: strEqIdx },
      ],
    },
  ];
}

// (#3191) The former private `emitThrowString` / `throwStringInstrs` copies (a
// verbatim duplicate of the canonical bare-string throw, kept local to avoid a
// circular dep on `expressions/`) now route through the layering-safe leaf
// module `./js-errors.ts` — `emitThrowString` (push) + `buildThrowStringInstrs`
// (returns the terminal `Instr[]` for an `if.then`/`else` arm).

// unpackedElemType / elemGetOp are canonical in shared.ts (#2934 — needed by
// loops.ts and type-coercion.ts too, and array-methods.ts is not importable
// from type-coercion.ts without a cycle). Imported below and re-exported for
// existing users of this module's surface.
export { elemGetOp, unpackedElemType };

/**
 * (#2648, mirrors #2593) Recover the packed-element load signedness ("s"/"u") of
 * a typed-array search-method receiver from its VIEW NAME — `Int8Array`/
 * `Int16Array` read sign-extending (`array.get_s`), `Uint8Array`/
 * `Uint8ClampedArray`/`Uint16Array` read zero-extending (`array.get_u`). Signed
 * and unsigned views share the same i8/i16 storage but read with opposite
 * sign-extension, so `indexOf`/`lastIndexOf`/`includes` MUST drive the element
 * load off the view name, not the storage kind. Returns undefined for a
 * non-integer-view receiver (caller falls back to the storage-kind heuristic).
 */
export function typedArraySearchSignedness(ctx: CodegenContext, receiver: ts.Expression): "s" | "u" | undefined {
  const t = ctx.checker.getTypeAtLocation(receiver);
  let name = t.getSymbol()?.name ?? t.aliasSymbol?.name;
  if (!name && ts.isNewExpression(receiver) && ts.isIdentifier(receiver.expression)) {
    name = receiver.expression.text;
  }
  return name ? typedArrayPackedSignedness(name) : undefined;
}

/**
 * Check if a callback argument is known to be non-callable at compile time.
 * Returns true if the argument is null, undefined, a number, string, or boolean literal.
 */
function isKnownNonCallable(ctx: CodegenContext, arg: ts.Expression): boolean {
  if (arg.kind === ts.SyntaxKind.NullKeyword) return true;
  if (arg.kind === ts.SyntaxKind.UndefinedKeyword) return true;
  if (arg.kind === ts.SyntaxKind.TrueKeyword || arg.kind === ts.SyntaxKind.FalseKeyword) return true;
  if (ts.isNumericLiteral(arg)) return true;
  if (ts.isStringLiteral(arg)) return true;
  if (ts.isIdentifier(arg) && arg.text === "undefined") return true;
  // Check TS type flags for known non-function types
  const tsType = ctx.checker.getTypeAtLocation(arg);
  const NON_CALLABLE_FLAGS =
    ts.TypeFlags.Undefined |
    ts.TypeFlags.Void |
    ts.TypeFlags.Null |
    ts.TypeFlags.BooleanLike |
    ts.TypeFlags.NumberLike |
    ts.TypeFlags.StringLike |
    ts.TypeFlags.BigIntLike |
    // A symbol is never callable → spec-correct §23.1.3.* step-3 TypeError for
    // every array HOF (e.g. `[].flatMap(Symbol())`, `[].map(Symbol())`). (#3200)
    ts.TypeFlags.ESSymbolLike;
  if (tsType.flags & NON_CALLABLE_FLAGS) return true;
  // (#2934 host-bridge A) A plain OBJECT type with NO call and NO construct
  // signatures is statically non-callable — `arr.map(new Object())`
  // (map/15.4.4.19-4-7) must throw the §23.1.3.18 step-3 TypeError BEFORE
  // iterating, instead of falling to the host callback bridge (which leaks
  // `env::__call_1_f64` into standalone AND mis-types the element arg —
  // "call[1] expected f64, found array.get of externref"). `any`/`unknown`
  // and union types stay dynamic (their flags are not Object), so an
  // imprecisely-typed value that may hold a function at runtime is never
  // gated.
  if (
    tsType.flags & ts.TypeFlags.Object &&
    !(tsType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) &&
    (tsType.getCallSignatures?.() ?? []).length === 0 &&
    (tsType.getConstructSignatures?.() ?? []).length === 0
  ) {
    return true;
  }
  return false;
}

/**
 * Emit TypeError for missing or non-callable callback argument.
 * Called by array callback methods (every, some, forEach, filter, map, reduce).
 * Returns true if a throw was emitted (caller should return early).
 */
function emitCallbackTypeCheck(
  ctx: CodegenContext,
  fctx: FunctionContext,
  callExpr: ts.CallExpression,
  methodName: string,
): boolean {
  // No callback argument → always throw
  if (callExpr.arguments.length < 1) {
    emitThrowTypeError(ctx, fctx, `${methodName} callback is not a function`);
    return true;
  }
  // Known non-callable literal → compile arg for side effects, then throw
  const cbArg = callExpr.arguments[0]!;
  // ArgumentListEvaluation reads the callback before Array.prototype.forEach
  // (or its siblings) can perform IsCallable. A genuinely unresolvable bare
  // identifier therefore throws ReferenceError, and must not fall through to
  // the generic `__call_*` callback bridge after identifier lowering has
  // already emitted that throw. Besides choosing the wrong error, that stale
  // bridge introduces an unsatisfiable host import in standalone output.
  // Runtime-eval globals remain dynamic and keep the ordinary callback path.
  if (ts.isIdentifier(cbArg) && ctx.oracle.isUnresolvableIdentifier(cbArg) && !ctx.runtimeEvalGlobalFunctionBindings) {
    compileExpression(ctx, fctx, cbArg);
    return true;
  }
  if (isKnownNonCallable(ctx, cbArg)) {
    const cbType = compileExpression(ctx, fctx, cbArg);
    if (cbType) fctx.body.push({ op: "drop" });
    emitThrowTypeError(ctx, fctx, `${methodName} callback is not a function`);
    return true;
  }
  return false;
}

/**
 * (#3126, the #3098 typed-lane residual) Gate for admitting a REF/REF_NULL
 * element receiver (native-string `string[]` vecs, object-struct `T[]`
 * arrays) into the native typed HOF impls on the HOST-FREE lanes
 * (standalone/wasi — the caller checks the lane; see hofElemKindOk for why
 * the gc host lane keeps its `__make_callback` fallback).
 *
 * The typed loops are element-kind agnostic on the CLOSURE path
 * (`buildClosureCallInstrs` — `call_ref` + `coercionInstrs`), but the
 * non-closure fallback (`buildBridgeCallInstrs`) converts the element to the
 * host bridge's f64 argument, which has no lowering for a GC struct element —
 * admitting that shape would emit invalid Wasm. So ref-element receivers are
 * admitted ONLY when the callback provably compiles to a GC closure struct:
 *   - inline arrow / function expression → `compileArrowAsClosure`, always a
 *     closure struct;
 *   - any other expression → transactional probe-compile (#1919 machinery),
 *     admitted iff the compiled type is a ref with registered ClosureInfo.
 * Missing or known-non-callable callbacks are admitted too: the typed impls
 * emit the spec §23.1.3 step-3 TypeError, which beats the fallback (an
 * unsatisfiable `env.__make_callback` host-import leak on these lanes).
 *
 * The opaque-externref callback residual (a callback VALUE typed `any`)
 * deliberately stays on the current fallback — that is #3015's bridge-path
 * slice, not this gate's scope.
 */
function refElemHofCallbackIsClosure(ctx: CodegenContext, fctx: FunctionContext, callExpr: ts.CallExpression): boolean {
  if (callExpr.arguments.length < 1) return true; // typed impl emits the spec TypeError
  const cbArg = callExpr.arguments[0]!;
  if (isKnownNonCallable(ctx, cbArg)) return true; // typed impl emits the spec TypeError
  if (ts.isArrowFunction(cbArg) || ts.isFunctionExpression(cbArg)) return true;
  const probed = probeCompiledType(ctx, fctx, () => compileExpression(ctx, fctx, cbArg));
  return (
    probed !== null &&
    probed !== undefined &&
    (probed.kind === "ref" || probed.kind === "ref_null") &&
    ctx.closureInfoByTypeIdx.has((probed as { typeIdx: number }).typeIdx)
  );
}

/**
 * (#4616) Globals with dedicated native codegen arms — safe inside a lifted
 * closure body. Anything else that resolves to NO user-source declaration is
 * assumed to be a host-provided ambient (TemporalHelpers, harness globals, …)
 * that only the __make_callback host lane can see; see the #2838 note on
 * hofElemKindOk for the 212-test regression that taught us this.
 */
const CLOSURE_SAFE_AMBIENT_GLOBALS = new Set([
  "Math",
  "JSON",
  "Object",
  "Array",
  "String",
  "Number",
  "Boolean",
  "Date",
  "RegExp",
  "Symbol",
  "Promise",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "console",
  "NaN",
  "Infinity",
  "undefined",
  "parseInt",
  "parseFloat",
  "isNaN",
  "isFinite",
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "EvalError",
  "ReferenceError",
  "URIError",
  "AggregateError",
  // (#4657) `Function` used as a VALUE inside a callback body — i.e. the
  // dynamic `new Function(<computed>)` / `Function(<computed>)` constructor —
  // has a dedicated native codegen arm on this lane exactly like the names
  // above it: `emitDynamicNewFunctionHostEval` lowers it to the
  // `env::__extern_new_function` shim (#2960/#4650), which resolves inside a
  // LIFTED closure body just as it does at top level. It was absent from this
  // set only because the #4616 audit enumerated data builtins, so it fell to
  // the `isDeclarationFile` catch-all below and was misclassified as a
  // host-only ambient. The consequence was NOT a safe degrade: for a
  // ref-element receiver the gc-lane fallback is the #3126 silent no-op, so
  // `objArray.forEach(w => { ... new Function(...) ... })` executed ZERO
  // iterations with no diagnostic — test262
  // `harness/wellKnownIntrinsicObjects.js` builds all ~380 intrinsics through
  // exactly that shape and reported "could not obtain %Array%".
  "Function",
]);

// These names are supplied by the Test262 realm/harness rather than being
// ordinary compiler intrinsics.  A callback that captures one must remain on
// the host callback path: inlining it into the ref-element lane would carry
// compiler-owned Temporal values into the harness (or vice versa), making
// methods such as `Duration.prototype.round` disappear.  The explicit deny
// list is deliberately small; it keeps the generic host fallback for realm
// objects while retaining the host-free fast path for callbacks that only use
// normal JS builtins.
// (#4628) `Temporal` came OUT of this set when it stopped being a host-only
// ambient: `src/temporal-provider.ts` binds it to a compiled, separately
// linked `@js-temporal/polyfill` provider, so a callback capturing it captures
// an ordinary user-source `const` the closure lane resolves fine.
//
// This removal is exactly the PR #2838 hazard the issue flagged (widening this
// gate flipped 212 Temporal tests pass→fail), so read WHAT the entry was
// doing: the deny list is consulted BEFORE the generic
// `decl === undefined || decl.getSourceFile().isDeclarationFile` test below.
// While `Temporal` is an undeclared host ambient — which is still every
// program that does NOT go through the provider — `valueDeclarationOf` returns
// undefined and that generic test already classifies it unsafe. So the entry
// was redundant for the hazard case and load-bearing only for the wired case,
// where it would have been the one thing forcing a genuinely-safe compiled
// binding onto the host-callback path (a silent no-op for a ref-element
// receiver, the #3126 residual). `TemporalHelpers` STAYS: it is a test262
// harness ambient, it is not what the provider makes real, and it is the
// specific name in the #2838 failure text ("TemporalHelpers is not defined"
// inside a lifted closure). Verified by tests/issue-4628-temporal-global.test.ts
// ("undeclared Temporal keeps the host-callback lane") plus tests/issue-3126.test.ts
// and tests/issue-4787-temporal-merge-group-regressions.test.ts.
const CLOSURE_UNSAFE_HOST_AMBIENTS = new Set(["TemporalHelpers", "Intl", "$262"]);

/**
 * (#4616) May this ref-element HOF call take the closure lane in the gc HOST
 * profile? Only when the inline callback's body resolves every identifier to a
 * user-source declaration or a native-codegen builtin — a body needing a
 * host-only ambient global must stay on the host-callback fallback (which is a
 * silent no-op for ref-element receivers, the pre-existing #3126 residual, but
 * never *wrong* for the widened set). Identifier callbacks are safe: the probe
 * in refElemHofCallbackIsClosure already proved they are compiled closures.
 */
function hofRefElemClosureLaneSafe(ctx: CodegenContext, callExpr: ts.CallExpression): boolean {
  const cbArg = callExpr.arguments[0];
  if (cbArg === undefined) return true;
  if (!ts.isArrowFunction(cbArg) && !ts.isFunctionExpression(cbArg)) return true;
  let safe = true;
  const visit = (node: ts.Node): void => {
    if (!safe) return;
    if (ts.isIdentifier(node)) {
      // Skip non-value positions: property names, declaration names.
      const parent = node.parent;
      if (ts.isPropertyAccessExpression(parent) && parent.name === node) return;
      if ((ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent)) && parent.name === node) return;
      if (CLOSURE_UNSAFE_HOST_AMBIENTS.has(node.text)) {
        safe = false;
        return;
      }
      if (CLOSURE_SAFE_AMBIENT_GLOBALS.has(node.text)) return;
      const decl = ctx.oracle.valueDeclarationOf(node);
      if (decl === undefined || decl.getSourceFile().isDeclarationFile) {
        safe = false;
        return;
      }
      // (#4728 merge_group regression) An OUTER binding whose static type is
      // error-`any` is a host-value capture in disguise — test262's Temporal
      // files bind `const earlier = new Temporal.PlainDateTime(...)` (an
      // undeclared host global, so the checker types it `any`) and call
      // `earlier.until(...)` inside `Object.entries(...).forEach(([u, i]) =>`.
      // The native ref-elem HOF lane silently mis-threads that shape (the
      // nested assert.throws arrow observed undefined tuple elements; the
      // expected RangeError never fired — the "pass → fail" slice of the
      // 03934689 widening). Bindings declared INSIDE the callback keep the
      // native lane.
      if (decl.pos < cbArg.pos || decl.end > cbArg.end) {
        const fact = ctx.oracle.typeFactOf(node);
        if (fact.kind === "any" || fact.kind === "unknown") safe = false;
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(cbArg.body);
  return safe;
}

// ── Guarded funcref cast (ref.test before ref.cast to avoid illegal cast traps) ──
export function guardedFuncRefCastInstrs(fctx: FunctionContext, funcTypeIdx: number): Instr[] {
  const tmpFunc = allocLocal(fctx, `__gfc_${fctx.locals.length}`, { kind: "funcref" } as ValType);
  return [
    { op: "local.tee", index: tmpFunc },
    { op: "ref.test", typeIdx: funcTypeIdx },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "ref_null", typeIdx: funcTypeIdx } as ValType },
      then: [
        { op: "local.get", index: tmpFunc },
        { op: "ref.cast_null", typeIdx: funcTypeIdx },
      ],
      else: [{ op: "ref.null", typeIdx: funcTypeIdx }],
    },
  ];
}

// ── Null guard for array method receivers ─────────────────────────────

/**
 * Emit a null check on the vec ref that was just tee'd into `localIdx`.
 * If null, throws TypeError via the exception tag instead of letting
 * struct.get trap with an unrecoverable Wasm trap.
 *
 * Stack: [ref_null] -> [ref_null]  (value is still on stack, unchanged)
 * The local already holds the value via local.tee before this call.
 */
export function emitReceiverNullGuard(
  ctx: CodegenContext,
  fctx: FunctionContext,
  localIdx: number,
  receiverExpr?: ts.Expression,
): void {
  // Skip null guard if receiver is provably non-null (e.g. const initialized from array literal)
  if (receiverExpr && isReceiverNonNull(receiverExpr, ctx.checker)) return;
  // Check if the value in the local is null
  fctx.body.push({ op: "local.get", index: localIdx });
  fctx.body.push({ op: "ref.is_null" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: buildThrowJsErrorInstrs(ctx, "TypeError", "Array method called on null or undefined", { flush: fctx }),
    else: [],
  });
}

/** Check if an expression is provably non-null (e.g. const initialized from array literal). */
function isReceiverNonNull(expr: ts.Expression, checker: ts.TypeChecker): boolean {
  let inner: ts.Expression = expr;
  while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
  switch (inner.kind) {
    case ts.SyntaxKind.NewExpression:
    case ts.SyntaxKind.ObjectLiteralExpression:
    case ts.SyntaxKind.ArrayLiteralExpression:
      return true;
    default:
      break;
  }
  if (ts.isIdentifier(inner)) {
    const sym = checker.getSymbolAtLocation(inner);
    if (sym) {
      const decl = sym.valueDeclaration;
      if (decl && ts.isVariableDeclaration(decl) && decl.initializer) {
        const declList = decl.parent;
        if (ts.isVariableDeclarationList(declList) && (declList.flags & ts.NodeFlags.Const) !== 0) {
          return isReceiverNonNull(decl.initializer, checker);
        }
      }
    }
  }
  return false;
}

/**
 * Prove `arr` is filled exactly once by `for (i=0; i<N; i++) arr.push(i)`
 * before this call and is otherwise only searched. Such a dense identity array
 * admits exact source-level indexOf/find results without reading its backing.
 */
function canonicalIdentityArrayLength(
  ctx: CodegenContext,
  receiver: ts.Expression,
  callExpr: ts.CallExpression,
): number | undefined {
  if (!ts.isIdentifier(receiver)) return undefined;
  let scope: ts.Node = callExpr;
  while (scope.parent && !ts.isFunctionLike(scope.parent) && !ts.isSourceFile(scope.parent)) scope = scope.parent;
  scope = scope.parent ?? scope;
  const declarations: ts.VariableDeclaration[] = [];
  const collectDeclarations = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === receiver.text) {
      declarations.push(node);
    }
    ts.forEachChild(node, collectDeclarations);
  };
  collectDeclarations(scope);
  if (declarations.length !== 1) return undefined;
  const declaration = declarations[0]!;
  if (
    !declaration.initializer ||
    !ts.isArrayLiteralExpression(declaration.initializer) ||
    declaration.initializer.elements.length !== 0
  ) {
    return undefined;
  }

  let fillLoop: ts.ForStatement | undefined;
  let length: number | undefined;
  let safe = true;
  const findFill = (node: ts.Node): void => {
    if (ts.isForStatement(node)) {
      const statement = ts.isBlock(node.statement)
        ? node.statement.statements.length === 1
          ? node.statement.statements[0]
          : undefined
        : node.statement;
      const expression = statement && ts.isExpressionStatement(statement) ? statement.expression : undefined;
      if (
        expression &&
        ts.isCallExpression(expression) &&
        ts.isPropertyAccessExpression(expression.expression) &&
        expression.expression.name.text === "push" &&
        ts.isIdentifier(expression.expression.expression) &&
        expression.expression.expression.text === receiver.text &&
        isIdentityFillLoop(ctx, node, expression)
      ) {
        fillLoop = node;
        length = Number((node.condition as ts.BinaryExpression).right.getText());
      }
    }
    ts.forEachChild(node, findFill);
  };
  findFill(scope);
  const visit = (node: ts.Node): void => {
    if (!safe) return;
    if (ts.isIdentifier(node) && node.text === receiver.text) {
      if (node === declaration.name) return;
      const property = node.parent;
      const methodCall = ts.isPropertyAccessExpression(property) ? property.parent : undefined;
      if (
        !ts.isPropertyAccessExpression(property) ||
        property.expression !== node ||
        methodCall === undefined ||
        !ts.isCallExpression(methodCall) ||
        methodCall.expression !== property ||
        !["push", "indexOf", "find"].includes(property.name.text)
      ) {
        safe = false;
        return;
      }
      if (property.name.text === "push") {
        let loop: ts.Node | undefined = methodCall.parent;
        while (loop && !ts.isForStatement(loop) && !ts.isFunctionLike(loop) && !ts.isSourceFile(loop)) {
          loop = loop.parent;
        }
        if (!ts.isForStatement(loop) || !isIdentityFillLoop(ctx, loop, methodCall)) {
          safe = false;
          return;
        }
        const condition = loop.condition as ts.BinaryExpression;
        const bound = Number((condition.right as ts.NumericLiteral).text);
        if (fillLoop && fillLoop !== loop) {
          safe = false;
          return;
        }
        fillLoop = loop;
        length = bound;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(scope);
  return safe && fillLoop && length !== undefined && fillLoop.getStart() < callExpr.getStart() ? length : undefined;
}

function isIdentityFillLoop(ctx: CodegenContext, loop: ts.ForStatement, push: ts.CallExpression): boolean {
  if (!loop.initializer || !ts.isVariableDeclarationList(loop.initializer)) return false;
  if (loop.initializer.declarations.length !== 1) return false;
  const induction = loop.initializer.declarations[0]!;
  if (!ts.isIdentifier(induction.name) || !induction.initializer || !ts.isNumericLiteral(induction.initializer)) {
    return false;
  }
  if (Number(induction.initializer.text) !== 0 || !loop.condition || !ts.isBinaryExpression(loop.condition))
    return false;
  if (
    !ts.isIdentifier(loop.condition.left) ||
    loop.condition.left.text !== induction.name.text ||
    loop.condition.operatorToken.kind !== ts.SyntaxKind.LessThanToken ||
    !ts.isNumericLiteral(loop.condition.right)
  ) {
    return false;
  }
  const length = Number(loop.condition.right.text);
  if (!Number.isSafeInteger(length) || length <= 0 || !loop.incrementor) return false;
  const increment = loop.incrementor;
  const incrementsByOne =
    ((ts.isPostfixUnaryExpression(increment) || ts.isPrefixUnaryExpression(increment)) &&
      increment.operator === ts.SyntaxKind.PlusPlusToken &&
      ts.isIdentifier(increment.operand) &&
      increment.operand.text === induction.name.text) ||
    (ts.isBinaryExpression(increment) &&
      increment.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(increment.left) &&
      increment.left.text === induction.name.text &&
      ts.isBinaryExpression(increment.right) &&
      increment.right.operatorToken.kind === ts.SyntaxKind.PlusToken &&
      ts.isIdentifier(increment.right.left) &&
      increment.right.left.text === induction.name.text &&
      ts.isNumericLiteral(increment.right.right) &&
      Number(increment.right.right.text) === 1);
  if (!incrementsByOne) return false;
  if (push.arguments.length !== 1 || !ts.isIdentifier(push.arguments[0]!)) return false;
  if (push.arguments[0]!.text !== induction.name.text) return false;
  const statement = ts.isBlock(loop.statement)
    ? loop.statement.statements.length === 1
      ? loop.statement.statements[0]
      : undefined
    : loop.statement;
  return statement !== undefined && ts.isExpressionStatement(statement) && statement.expression === push;
}

function identityFindLiteral(
  ctx: CodegenContext,
  callExpr: ts.CallExpression,
  length: number,
): ts.NumericLiteral | undefined {
  if (callExpr.arguments.length !== 1 || !ts.isArrowFunction(callExpr.arguments[0]!)) return undefined;
  const callback = callExpr.arguments[0]!;
  if (callback.parameters.length !== 1 || !ts.isIdentifier(callback.parameters[0]!.name)) return undefined;
  if (!ts.isBinaryExpression(callback.body)) return undefined;
  const body = callback.body;
  if (
    body.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken &&
    body.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsToken
  ) {
    return undefined;
  }
  const paramSymbol = ctx.checker.getSymbolAtLocation(callback.parameters[0]!.name);
  const literal = ts.isNumericLiteral(body.left) ? body.left : ts.isNumericLiteral(body.right) ? body.right : undefined;
  const param = literal === body.left ? body.right : body.left;
  if (!literal || !ts.isIdentifier(param) || ctx.checker.getSymbolAtLocation(param) !== paramSymbol) return undefined;
  const value = Number(literal.text);
  return Number.isSafeInteger(value) && value >= 0 && value < length ? literal : undefined;
}

function typeIncludesUndefined(type: ts.Type): boolean {
  if ((type.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !== 0) return true;
  if (type.isUnion()) return type.types.some((member) => typeIncludesUndefined(member));
  return false;
}

function shouldReturnUndefinedCapableResult(
  ctx: CodegenContext,
  callExpr: ts.CallExpression,
  expectedType?: ValType,
): boolean {
  let parent: ts.Node | undefined = callExpr.parent;
  while (
    parent &&
    (ts.isParenthesizedExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isTypeAssertionExpression(parent) ||
      ts.isNonNullExpression(parent))
  ) {
    parent = parent.parent;
  }
  if (parent && ts.isExpressionStatement(parent)) return false;
  if (expectedType && expectedType.kind !== "externref" && expectedType.kind !== "ref_extern") return false;
  return typeIncludesUndefined(ctx.checker.getTypeAtLocation(callExpr));
}

/**
 * #2105 — value-rep P2 boolean-brand rollout for `Array.prototype.join` /
 * `toString`. A boolean array lowers to an i32 WasmGC element array, but the
 * `{ kind: "i32", boolean: true }` brand is structural-only and does not
 * survive into `arrDef.element` (arrays dedupe by structure). So the join
 * element-stringify path otherwise renders booleans numerically ("1"/"0").
 * Recover the boolean-ness from the receiver's TS element type instead:
 * `boolean[]`/`(true|false)[]` → number-index type is `boolean`.
 */
function arrayElementIsBoolean(ctx: CodegenContext, receiverExpr: ts.Expression): boolean {
  const recvTsType = ctx.checker.getTypeAtLocation(receiverExpr);
  if (!recvTsType) return false;
  const elemTsType = recvTsType.getNumberIndexType();
  return elemTsType ? isBooleanType(elemTsType) : false;
}

function arrayElementToExternrefInstrs(ctx: CodegenContext, fctx: FunctionContext, elemType: ValType): Instr[] {
  if (elemType.kind === "i8" || elemType.kind === "i16") {
    return coercionInstrs(ctx, { kind: "i32" }, { kind: "externref" }, fctx);
  }
  if (elemType.kind === "f32") {
    return [{ op: "f64.promote_f32" }, ...coercionInstrs(ctx, { kind: "f64" }, { kind: "externref" }, fctx)];
  }
  return coercionInstrs(ctx, elemType, { kind: "externref" }, fctx);
}

// ── Bounds-checked array access ───────────────────────────────────────

/**
 * Emit a bounds-checked array.get.  Stack must contain [arrayref, i32 index].
 * If the index is out of bounds (< 0 or >= array.len), a default value for the
 * element type is produced instead of trapping.
 *
 * #1396 — `useUndefinedSentinel` (default false): when true AND `elementType`
 * is `externref`/`ref_extern`, the OOB else-branch pushes the JS `undefined`
 * value (via `__get_undefined` host import) instead of `ref.null.extern`.
 * Required by destructuring callers — JS spec §13.7.5.5 fires defaults only
 * for `undefined`, not for `null`, and `ref.null.extern` surfaces to JS as
 * `null` causing `__extern_is_undefined` to return 0 → default never fires
 * for OOB extern-array reads (~320 fails in `for-of/dstr`, ~171 in
 * `assignment/dstr`).
 */
export function emitBoundsCheckedArrayGet(
  fctx: FunctionContext,
  arrTypeIdx: number,
  elementType: ValType,
  ctx?: CodegenContext,
  useUndefinedSentinel = false,
  // (#2593) Explicit signedness for a packed i8/i16 element, driven by the
  // typed-array VIEW name (not the storage kind): `Int8Array`/`Int16Array` read
  // sign-extending (`get_s`), `Uint8Array`/`Uint8ClampedArray`/`Uint16Array` read
  // zero-extending (`get_u`). When undefined, fall back to the legacy
  // storage-kind heuristic (i8→get_u, i16→get_s) for non-typed-array callers.
  signedness?: "s" | "u",
  // (#2773 S7) Optional replacement for the default `array.len(arr)` upper
  // bound: instructions that push the LOGICAL length (i32). A grown vec's
  // backing array is over-allocated (capacity = max(idx+1, cap*2, 4)), so
  // `array.len` over-reports the bound and an index in [length, capacity)
  // silently reads the element DEFAULT (null/0) instead of being OOB —
  // `var k=[]; k[0]=1; k[1]` read null, not `undefined` (the test262 HOF
  // "-c-ii-5" family). The vec-struct call site passes
  // `[local.get vecRef, struct.get length]` here. When undefined, the legacy
  // capacity bound is emitted — every existing caller is byte-identical.
  lengthBoundInstrs?: Instr[],
): void {
  // Save index and array ref to locals so we can use them in both branches
  const idxLocal = allocLocal(fctx, `__bounds_idx_${fctx.locals.length}`, { kind: "i32" });
  const arrLocal = allocLocal(fctx, `__bounds_arr_${fctx.locals.length}`, { kind: "ref", typeIdx: arrTypeIdx });

  fctx.body.push({ op: "local.set", index: idxLocal }); // save index
  fctx.body.push({ op: "local.set", index: arrLocal }); // save array ref

  // (#1396) When the destructuring caller asked for an undefined sentinel and
  // the element type is externref-shaped, register the `__get_undefined`
  // import BEFORE building the if-block so its funcIdx is stable and any
  // index-shifts have already been flushed into the current function body.
  let undefinedFuncIdx: number | undefined;
  if (useUndefinedSentinel && ctx && (elementType.kind === "externref" || elementType.kind === "ref_extern")) {
    undefinedFuncIdx = ensureGetUndefined(ctx);
    if (undefinedFuncIdx !== undefined) flushLateImportShifts(ctx, fctx);
  }

  // Condition: idx >= 0 && idx < bound
  // We use: (unsigned)idx < bound — this handles negative indices too
  // since negative i32 interpreted as unsigned is > any valid length.
  // (#2773 S7) The bound is the caller-supplied LOGICAL length when provided
  // (vec length field — capacity may exceed it after a grow), else the
  // backing-array capacity (`array.len`, the legacy byte-identical default).
  fctx.body.push({ op: "local.get", index: idxLocal });
  if (lengthBoundInstrs) {
    // Clone per use — a caller may pass the same template to sibling helpers,
    // and one Instr OBJECT must never appear twice in a body (the DCE type
    // remap would visit it twice; see reference_shared_instr_object_dce_double_remap).
    fctx.body.push(...lengthBoundInstrs.map((i) => ({ ...i })));
  } else {
    fctx.body.push({ op: "local.get", index: arrLocal });
    fctx.body.push({ op: "array.len" });
  }
  fctx.body.push({ op: "i32.lt_u" });

  // Build the "then" branch: in-bounds -> array.get. (#2593) For a packed i8/i16
  // element, prefer the view-name-driven `signedness` (get_s for signed views,
  // get_u for unsigned); fall back to the legacy storage-kind heuristic when the
  // caller did not supply it (i32 packed elements use plain `array.get` — i32 has
  // no sign-extension distinction; the value IS the full 32 bits).
  const packedLoad =
    elementType.kind === "i8" || elementType.kind === "i16"
      ? signedness === "s"
        ? "array.get_s"
        : signedness === "u"
          ? "array.get_u"
          : elementType.kind === "i8"
            ? "array.get_u"
            : "array.get_s"
      : "array.get";
  const valueType: ValType = elementType.kind === "i8" || elementType.kind === "i16" ? { kind: "i32" } : elementType;

  const thenInstrs: Instr[] = [
    { op: "local.get", index: arrLocal },
    { op: "local.get", index: idxLocal },
    { op: packedLoad, typeIdx: arrTypeIdx },
  ];

  // Build the "else" branch: out-of-bounds -> default value (or JS undefined
  // when the destructuring caller opted in via `useUndefinedSentinel`).
  // (#2106 S1) In standalone/nativeStrings with the $undefined singleton flag ON,
  // an OOB externref destructuring read must yield the tag-1 singleton (not raw
  // `ref.null.extern`), so the externref default-check (`__extern_is_undefined`,
  // singleton-only under the flag) fires the default — the for-of loop-head
  // array-destructuring producer arm (`for (const [a=9] of [[]]) …`). Gated on
  // `useUndefinedSentinel` so non-destructuring array reads are byte-identical;
  // flag OFF → `defaultValueInstrs` (`ref.null.extern`, byte-identical).
  const singletonOob =
    useUndefinedSentinel && ctx && (elementType.kind === "externref" || elementType.kind === "ref_extern")
      ? undefinedExternInstrs(ctx)
      : undefined;
  const elseInstrs: Instr[] =
    undefinedFuncIdx !== undefined
      ? [{ op: "call", funcIdx: undefinedFuncIdx }]
      : (singletonOob ?? defaultValueInstrs(valueType));

  // When the element type is a non-null ref, the else branch produces ref.null
  // which is ref_null. Use ref_null as the block type so both branches validate,
  // then narrow back to ref with ref.as_non_null.
  const needsNullableBlock = valueType.kind === "ref";
  const blockType: ValType = needsNullableBlock
    ? { kind: "ref_null", typeIdx: (valueType as { typeIdx: number }).typeIdx }
    : valueType;

  fctx.body.push({
    op: "if",
    blockType: { kind: "val" as const, type: blockType },
    then: thenInstrs,
    else: elseInstrs,
  });

  // Narrow ref_null back to ref so downstream struct.get etc. validate
  if (needsNullableBlock) {
    fctx.body.push({ op: "ref.as_non_null" });
  }

  // (#2001 S1) Read-boundary `$Hole → undefined` mapping. An in-bounds slot of
  // an `any[]` / untyped (externref-element) vec may hold the `$Hole` sentinel
  // for a literal elision (`[1, , 3]`). Per §ToObject/Get an absent index reads
  // as `undefined`, NOT the sentinel — so a hole must never leak into a binding,
  // callback arg, coercion, or `===`. Gated on `usesArrayHoles` (the module
  // actually has elisions) AND externref element (so number[]/boolean[]/struct[]
  // reads stay byte-identical — no `ref.test` on an f64/i32/typed-ref).
  if (ctx?.usesArrayHoles && elementType.kind === "externref") {
    emitHoleToUndefined(ctx, fctx);
  }
  // (#4491 T11) f64 twin of the same read boundary.
  if (ctx) emitF64HoleToUndef(ctx, fctx, elementType);
}

/**
 * Clamp an index for JS array methods: if idx < 0, idx = max(0, len + idx);
 * also clamp to max len.  idxLocal is updated in-place.
 */
export function emitClampIndex(fctx: FunctionContext, idxLocal: number, lenLocal: number): void {
  // if (idx < 0) idx = max(0, len + idx)
  fctx.body.push({ op: "local.get", index: idxLocal });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "i32.lt_s" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [
      { op: "local.get", index: lenLocal },
      { op: "local.get", index: idxLocal },
      { op: "i32.add" },
      { op: "local.set", index: idxLocal },
      // if still < 0, clamp to 0
      { op: "local.get", index: idxLocal },
      { op: "i32.const", value: 0 },
      { op: "i32.lt_s" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "i32.const", value: 0 },
          { op: "local.set", index: idxLocal },
        ],
      },
    ],
  });
  // Clamp to len: if (idx > len) idx = len
  fctx.body.push({ op: "local.get", index: idxLocal });
  fctx.body.push({ op: "local.get", index: lenLocal });
  fctx.body.push({ op: "i32.gt_s" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [
      { op: "local.get", index: lenLocal },
      { op: "local.set", index: idxLocal },
    ],
  });
}

/**
 * Clamp a value to be >= 0.  local is updated in-place.
 */
export function emitClampNonNeg(fctx: FunctionContext, local: number): void {
  fctx.body.push({ op: "local.get", index: local });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "i32.lt_s" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [
      { op: "i32.const", value: 0 },
      { op: "local.set", index: local },
    ],
  });
}

/**
 * (#3201 write-path) Grow a vec's physical WasmGC backing array so it can hold
 * at least `neededLen` elements, then keep `dataLocal` pointing at the (possibly
 * reallocated) backing. The mirror-image of the READ family's
 * {@link emitBackingClampedCopyLen}: those methods COPY out and clamp the count
 * down to the backing so they never trap; the in-place WRITE/move family
 * (`fill`/`reverse`/`copyWithin`) must instead materialise the missing slots so
 * the write itself lands in-bounds.
 *
 * A sparse array — logical `.length` (field 0) pushed beyond the backing via the
 * `a.length = N` setter — has `array.len(data) < length`. `fill`/`reverse`/
 * `copyWithin` then index `data[i]` up to the LOGICAL length and TRAP ("array
 * element access out of bounds"), an uncatchable abort. This helper reallocates
 * the backing to `neededLen` (`array.new_default` + `array.copy` of the existing
 * prefix + `struct.set` field 1), exactly the grow shape used by
 * `compileArrayPush` / `maybeEmitVecLengthGrowth`, so the vec regains
 * `capacity ≥ neededLen` and the write is bounds-safe. The freshly-allocated
 * tail is default-initialised (0 / null) — the beyond-backing indices that were
 * absent holes; `fill` overwrites its range unconditionally (spec-exact,
 * §23.3.3.7 writes without a HasProperty guard), while `reverse`/`copyWithin`
 * move those defaults (the minor undefined-vs-null fidelity gap for externref
 * sparse arrays matches the read family's precedent; the trap-first mandate,
 * #3185 §4, prioritises eliminating the abort).
 *
 * Grow only — never shrinks. A non-sparse vec (backing capacity ≥ neededLen) is
 * a runtime no-op (the `if` is not taken). Callers gate the EMISSION on
 * `ctx.standalone`/`ctx.wasi` so the host/gc lane stays byte-identical.
 */
function emitEnsureBackingCapacity(
  fctx: FunctionContext,
  vecLocal: number,
  dataLocal: number,
  vecTypeIdx: number,
  arrTypeIdx: number,
  neededLenLocal: number,
): void {
  const oldCap = allocLocal(fctx, `__ensure_ocap_${fctx.locals.length}`, { kind: "i32" });
  const newData = allocLocal(fctx, `__ensure_ndata_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });

  // if (array.len(data) < needed) grow backing to `needed`
  fctx.body.push({ op: "local.get", index: dataLocal });
  fctx.body.push({ op: "array.len" });
  fctx.body.push({ op: "local.tee", index: oldCap });
  fctx.body.push({ op: "local.get", index: neededLenLocal });
  fctx.body.push({ op: "i32.lt_s" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [
      // newData = array.new_default(needed)
      { op: "local.get", index: neededLenLocal },
      { op: "array.new_default", typeIdx: arrTypeIdx },
      { op: "local.set", index: newData },
      // array.copy newData[0..oldCap] = data[0..oldCap]
      { op: "local.get", index: newData },
      { op: "i32.const", value: 0 },
      { op: "local.get", index: dataLocal },
      { op: "i32.const", value: 0 },
      { op: "local.get", index: oldCap },
      { op: "array.copy", dstTypeIdx: arrTypeIdx, srcTypeIdx: arrTypeIdx },
      // vec.data = newData
      { op: "local.get", index: vecLocal },
      { op: "local.get", index: newData },
      { op: "ref.as_non_null" },
      { op: "struct.set", typeIdx: vecTypeIdx, fieldIdx: 1 },
      // keep the caller's data pointer pointing at the grown backing
      { op: "local.get", index: newData },
      { op: "local.set", index: dataLocal },
    ],
  });
}

// ── Array method calls (pure Wasm, no host imports) ─────────────────

/** Resolve array type info from a TS type. Returns null if not a Wasm GC vec struct. */
export function resolveArrayInfo(
  ctx: CodegenContext,
  tsType: ts.Type,
): { vecTypeIdx: number; arrTypeIdx: number; elemType: ValType } | null {
  // In fast mode, strings are NativeString structs that look like arrays
  // (struct { len: i32, data: ref array }). Reject them here so string
  // methods are dispatched via compileNativeStringMethodCall instead.
  if (ctx.nativeStrings && ctx.nativeStrTypeIdx >= 0 && isStringType(tsType)) return null;
  const wasmType = resolveWasmType(ctx, tsType);
  return resolveArrayInfoFromWasmType(ctx, wasmType);
}

function resolveArrayInfoFromWasmType(
  ctx: CodegenContext,
  wasmType: ValType | undefined,
): { vecTypeIdx: number; arrTypeIdx: number; elemType: ValType } | null {
  if (!wasmType) return null;
  if (wasmType.kind !== "ref" && wasmType.kind !== "ref_null") return null;
  const vecTypeIdx = (wasmType as { typeIdx: number }).typeIdx;
  const vecDef = ctx.mod.types[vecTypeIdx];
  if (!vecDef || vecDef.kind !== "struct") return null;
  if (vecDef.fields.length < 2) return null;
  const dataField = vecDef.fields[1]!;
  if (dataField.type.kind !== "ref") return null;
  const arrTypeIdx = dataField.type.typeIdx;
  const arrDef = ctx.mod.types[arrTypeIdx];
  if (!arrDef || arrDef.kind !== "array") return null;
  return { vecTypeIdx, arrTypeIdx, elemType: arrDef.element };
}

function inferExpressionWasmType(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.Expression,
  allowProbe = true,
): ValType | undefined {
  if (ts.isIdentifier(expr)) {
    const name = expr.text;
    const localIdx = fctx.localMap.get(name);
    if (localIdx !== undefined) return getLocalType(fctx, localIdx);
    const gIdx = ctx.moduleGlobals.get(name);
    if (gIdx !== undefined) return ctx.mod.globals[localGlobalIdx(ctx, gIdx)]?.type;
  }

  if (!allowProbe) return undefined;
  // #1919 — transactional probe: compile only to read the produced ValType, then
  // roll back the body AND any locals / late imports / errors the compile leaked.
  const probeResult = probeCompiledType(ctx, fctx, () => compileExpression(ctx, fctx, expr));
  return probeResult ?? undefined;
}

function resolveArrayInfoForExpression(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.Expression,
  tsType: ts.Type,
): { vecTypeIdx: number; arrTypeIdx: number; elemType: ValType } | null {
  return (
    resolveArrayInfo(ctx, tsType) ?? resolveArrayInfoFromWasmType(ctx, inferExpressionWasmType(ctx, fctx, expr, false))
  );
}

export const ARRAY_METHODS = new Set([
  "push",
  "pop",
  "shift",
  "unshift",
  "indexOf",
  "includes",
  "slice",
  "concat",
  "join",
  "reverse",
  "splice",
  "at",
  "fill",
  "copyWithin",
  "lastIndexOf",
  "sort",
  "filter",
  "map",
  "reduce",
  "reduceRight",
  "forEach",
  "find",
  "findIndex",
  "findLast",
  "findLastIndex",
  "some",
  "every",
  "entries",
  "keys",
  "values",
  "@@iterator", // Array.prototype[Symbol.iterator] === Array.prototype.values (#854)
  "toReversed",
  "toSorted",
  "toSpliced",
  "with",
  "flat",
  "flatMap",
  // #1997: Array.prototype.toString() (§23.1.3.36) delegates to join with the
  // default "," separator. Without this, it fell through to the generic object
  // dispatch and produced "[object Array]".
  "toString",
  // (#2863 Phase 2) Array/TypedArray.prototype.toLocaleString — recognised only
  // under --target standalone/wasi (host-guarded at the gates below), where it
  // has no host `__extern_toLocaleString` carrier. The locale-independent
  // default collapses to the same comma-join as toString (§23.1.3.32).
  "toLocaleString",
  // TypedArray-specific (#1664) — native WasmGC lowering avoids the generic
  // __extern_get / __extern_length host-import fallback under --target wasi.
  "set",
  "subarray",
]);

/**
 * (#3058 Bucket A, first slice) Read-side TypedArray proto-methods that (a) produce NO
 * new TypedArray value so they can run over a materialized f64-vec copy of a dynamic
 * `$__ta_dyn_view` (via {@link emitTaDynViewToVec}) through the ordinary f64-vec method
 * impl, AND (b) whose non-dyn-view ELSE arm (re-dispatched through
 * {@link compileExpression}) stays **host-import-free** in the standalone lane — a hard
 * requirement, because both arms are emitted and a single `env.*` import in the (never-
 * executed-for-a-dyn-view) ELSE arm still makes the pure-Wasm module fail to
 * instantiate.
 *
 * BANKED (their externref ELSE arm pulls a host import in standalone, which would poison
 * the module):
 *   - `join` → `env.<TA>_join`
 *   - the callback methods `every`/`some`/`forEach` → `env.__make_callback`
 *     (`find`/`findIndex` flipped via #3162; `findLast`/`findLastIndex` via
 *     #2872 slice 5; `reduce`/`reduceRight` via the #2872 slice-4 re-entry —
 *     their ELSE arms are de-leaked by the `tryExternClassMethodOnAny`
 *     refusals in calls-closures.ts)
 * These flip only once the standalone externref-receiver callback/join paths are native
 * (a separate follow-up). (#2903 R4 UPDATE) The SCALAR callback methods above
 * (find/findIndex/findLast/findLastIndex/every/some/forEach/reduce/reduceRight)
 * on a DIRECT (`$__vec_i8_byte`-style) carrier are now de-leaked BEFORE reaching
 * here — intercepted in `expressions/calls.ts` and routed to the native
 * `__call_m_<name>`/`__hof_<name>` substrate (host-free). This banked ELSE arm
 * still serves the `$__ta_dyn_view` dynamic-view shape (kept per #3058/#3162) and
 * `join`; do NOT add a competing direct-carrier de-leak here. `map`/`filter`
 * (typed-RESULT) remain banked for #2903 R4b. Also banked: in-place mutators (`fill`/`copyWithin`/`reverse`/
 * `sort` — Bucket B, need write-back) and species/new-view producers (`slice`/`subarray`/
 * `map`/`filter`/`with`/`toSorted`/`toReversed` — Bucket C, need real-buffer identity).
 */
const DYN_VIEW_READ_METHODS = new Set<string>([
  "at",
  "indexOf",
  "lastIndexOf",
  "includes",
  "toLocaleString",
  // (#2872) Read-side CALLBACK methods that return a scalar (NO new TypedArray
  // allocation) with Array-identical semantics. The two-arm materializes the
  // dyn-view to an `$__vec_f64` and re-enters the ORDINARY array-method HOF impl
  // — reusing the existing native array-HOF machinery verbatim (no per-method TA
  // handler). Scoped to `reduce`/`reduceRight` in this slice: they measured
  // clean (+2 pass, 0 CE, 0 regression). Deliberately EXCLUDED pending
  // follow-ups: `every`/`some`/`forEach` (detached-buffer
  // tests regress — the materialization snapshots before a mid-callback detach),
  // `map`/`filter` (return a NEW same-kind TA, not an f64-vec), `sort`/`toSorted`
  // (TA default comparator is NUMERIC, not Array's lexicographic), `with`/
  // `toReversed` (new TAs). `includes` (above) is boolean-returning and lights
  // up via the {@link BOOLEAN_RESULT_METHODS} boxing fix below.
  "reduce",
  "reduceRight",
  // (#3162) find/findIndex — see {@link FIND_METHODS}. Standalone-gated in the
  // two-arm predicate; gc/host keeps the pre-existing path.
  "find",
  "findIndex",
  // (#2872 slice 5) findLast/findLastIndex — same FIND_METHODS `__hof_<name>`
  // substrate route (the #3098 helpers carry the backward flag), which
  // BYPASSES the legacy `compileArrayFind` re-entry whose missing
  // `__call_1_f64` registration was the original exclusion reason here.
  // Paired with the scalar-HOF any-receiver decline in
  // `tryExternClassMethodOnAny` (calls-closures.ts) so the ELSE arm stays
  // host-import-free — both are needed: the two-arm alone still leaked
  // `env::<TA>_findLast[Index]` from the compiled-but-never-run ELSE arm.
  "findLast",
  "findLastIndex",
]);

/**
 * (#3162) Two-arm methods whose THEN arm (materialized `$__vec_f64`) is routed
 * through the standalone #3098 native `__hof_<name>` substrate instead of the
 * legacy `compileArrayFind` re-entry — the substrate returns an externref with
 * the spec `undefined` (`ref.null.extern`) not-found sentinel and threads
 * `thisArg`, where the legacy re-entry boxed a NaN sentinel (`__box_number`,
 * failing `assert.sameValue(result, undefined)`) and dropped `thisArg`.
 * `reduce`/`reduceRight` keep their existing re-entry (no miss sentinel).
 */
const FIND_METHODS = new Set<string>(["find", "findIndex", "findLast", "findLastIndex"]);

/**
 * (#2872) Dyn-view read-side methods whose result is a BOOLEAN (`true`/`false`),
 * so the two-arm boxes the impl's raw i32 via `__box_boolean` (not the generic
 * number box) — see {@link coerceArmToExternref}. `includes` was already in the
 * read set and shared the same latent mis-box.
 */
const BOOLEAN_RESULT_METHODS = new Set<string>(["every", "some", "includes"]);

/**
 * (#3058) Call expressions whose dyn-view two-arm ELSE arm is CURRENTLY re-dispatching
 * through {@link compileExpression} to reproduce the exact non-dyn-view path. The
 * two-arm gate skips a marked node so the re-dispatch runs the ORDINARY method
 * compilation (the externref/plain-array/host fallback) instead of re-entering the
 * two-arm (infinite recursion). Keyed by node identity (per-compile nodes) — never
 * leaks across compiles.
 */
const dynViewTwoArmActive = new WeakSet<ts.CallExpression>();

/**
 * (#3058) True when identifier `name` resolves to an `externref`-typed local — the
 * static rep of an `any`-typed variable, which is the ONLY shape a boxed
 * `$__ta_dyn_view` receiver can take. Restricting the two-arm to externref locals
 * keeps the runtime `ref.test` off statically-typed array/TA receivers (which can
 * never be a dyn view) — pure overhead avoidance, and it matches the B1 rebind's
 * identifier-local restriction.
 */
function dynViewReceiverIsExternref(fctx: FunctionContext, name: string): boolean {
  const localIdx = fctx.localMap.get(name);
  if (localIdx === undefined) return false;
  const t = getLocalType(fctx, localIdx);
  return t !== undefined && t.kind === "externref";
}

/**
 * (#3058) Coerce a just-compiled method-arm result (already on the Wasm stack, or
 * VOID) to `externref` so both arms of the dyn-view two-arm branch leave exactly one
 * externref (the branch's unified result rep). Returns false when the arm declined
 * (null/undefined) — the caller then abandons the two-arm and falls back to the
 * ordinary single path.
 */
function coerceArmToExternref(
  ctx: CodegenContext,
  fctx: FunctionContext,
  r: ValType | null | undefined | typeof VOID_RESULT,
  treatNullAsVoid = false,
  // (#2872) When the arm result is a BOOLEAN-returning method (`every`/`some`/
  // `includes`), its impl leaves a raw i32 (0/1). The generic `coerceType`
  // i32→externref path boxes it as a NUMBER (`__box_number`), so the boxed
  // result is `0`/`1`, not `false`/`true` — `result === false` then fails
  // (truthiness still works, which masked this). Box via `__box_boolean` so the
  // spec `assert.sameValue(…, false)` identity holds. Falls back to the generic
  // number box when the native helper is unavailable (byte-identical to before).
  boolResult = false,
): boolean {
  if (r === undefined || r === null) {
    // THEN arm (treatNullAsVoid=false): a null/undefined from the recursive f64-vec
    // impl means the method genuinely didn't compile — decline the whole two-arm.
    // ELSE arm (treatNullAsVoid=true): the call WAS re-dispatched (side effects
    // emitted); a null result is a void expression — push undefined-as-externref so
    // the branch stays balanced rather than declining.
    if (!treatNullAsVoid) return false;
    fctx.body.push({ op: "ref.null.extern" });
    return true;
  }
  if (r === VOID_RESULT) {
    fctx.body.push({ op: "ref.null.extern" });
    return true;
  }
  const vt = r as ValType;
  if (boolResult && vt.kind === "i32") {
    const boxBoolIdx = ctx.funcMap.get("__box_boolean");
    if (boxBoolIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx: boxBoolIdx });
      return true;
    }
  }
  if (vt.kind !== "externref") coerceType(ctx, fctx, vt, { kind: "externref" });
  return true;
}

/**
 * (#3058) Emit the runtime `ref.test $__ta_dyn_view` two-arm for a read-side Bucket-A
 * method on an `any`/externref receiver in a `moduleUsesDynTaView` module.
 *
 *   if (ref.test $__ta_dyn_view <recv>) {
 *     emitTaDynViewValidate(dv)          // §23.2.3.* step 1 ValidateTypedArray (OOB → TypeError)
 *     mat = emitTaDynViewToVec(dv)        // widen runtime kind → $__vec_f64
 *     <ordinary f64-vec method impl over mat>       // arm 1 (recursive compileArrayMethodCall)
 *   } else {
 *     <EXACT existing method compilation of the WHOLE call>   // arm 2 (unchanged)
 *   }
 *
 * Arm 1 re-enters {@link compileArrayMethodCall} with `skipDynViewWrap=true` over the
 * receiver identifier rebound to the materialized f64-vec local (a concrete vec ref, so
 * it can't re-trigger the two-arm). Arm 2 re-dispatches the ENTIRE call expression via
 * {@link compileExpression} — reproducing the caller's exact non-dyn-view behavior
 * INCLUDING every host/externref fallback that lives ABOVE compileArrayMethodCall (an
 * externref receiver makes compileArrayMethodCall return `undefined`, so the real impl
 * is the caller's tail, not reachable by re-entering compileArrayMethodCall). A
 * `dynViewTwoArmActive` guard on the call node prevents the re-dispatch from
 * re-entering this two-arm (infinite recursion). Both results unify to `externref`.
 * Returns the result ValType, or `undefined` when arm 1 declines (caller runs the
 * single path).
 *
 * Late-import safety: the outer body + both arm buffers stay registered on
 * `fctx.savedBodies` for the whole build, so any late-import funcIdx shift triggered
 * inside an arm patches every already-emitted funcIdx (the shift walker dedups by
 * array identity, so double-registration is harmless).
 */
/**
 * Gate for the (#3058) dyn-view two-arm wrap — extracted from
 * `compileArrayMethodCall` so the function stays inside its size budget.
 * Behaviour-identical; each clause keeps its original rationale.
 */
function shouldWrapDynViewTwoArm(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  callExpr: ts.CallExpression,
  methodName: string,
  skipDynViewWrap: boolean,
): boolean {
  return (
    !skipDynViewWrap &&
    ctx.moduleUsesDynTaView &&
    !dynViewTwoArmActive.has(callExpr) &&
    ts.isPropertyAccessExpression(propAccess) &&
    DYN_VIEW_READ_METHODS.has(methodName) &&
    // (#3162) find/findIndex only join the two-arm under standalone — their
    // correct THEN arm is the standalone-only #3098 `__hof_<name>` substrate
    // (see FIND_METHODS). In gc/host mode they stay on the pre-existing path.
    (!FIND_METHODS.has(methodName) || ctx.standalone) &&
    // (#2872) The static per-method impls the arms route to hard-require their
    // search/index argument. A 0-arg call must NOT be promoted from the
    // tolerant generic ladder into that hard CE — skip the wrap and keep the
    // pre-#2872 lowering for it.
    // (#5121 S1) The three search/index rejects this clause was written for are
    // GONE — `includes` (#2872), `at` (#5095) and now `indexOf`/`lastIndexOf`
    // all model an absent argument. The clause STAYS because the set above also
    // holds the callback methods (`reduce`, `reduceRight`, `find`, …), whose
    // typed impls still hard-require their callback; narrowing it to just those
    // would move `ta.indexOf()` onto a different lowering, which is a lowering
    // change with its own blast radius and no defect behind it. Deliberately
    // left for whoever needs it — same call #5095 made.
    (callExpr.arguments.length >= 1 || methodName === "toLocaleString") &&
    ts.isIdentifier(propAccess.expression) &&
    dynViewReceiverIsExternref(fctx, propAccess.expression.text)
  );
}

const DYN_VIEW_SPECIES_METHODS = new Set<string>(["map", "filter", "slice", "subarray"]);

function shouldWrapDynViewSpeciesTwoArm(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  callExpr: ts.CallExpression,
  methodName: string,
  skipDynViewWrap: boolean,
): boolean {
  return (
    !skipDynViewWrap &&
    noJsHost(ctx) &&
    ctx.moduleUsesDynTaView &&
    !dynViewTwoArmActive.has(callExpr) &&
    ts.isPropertyAccessExpression(propAccess) &&
    DYN_VIEW_SPECIES_METHODS.has(methodName) &&
    ts.isIdentifier(propAccess.expression) &&
    dynViewReceiverIsExternref(fctx, propAccess.expression.text)
  );
}

/**
 * (#4449) Runtime-kind producer arm for dynamic TypedArray views.  The
 * existing ordinary vector methods remain the callback/index algorithms; this
 * wrapper only supplies their f64 materialized input, performs one shared
 * TypedArraySpeciesCreate, and copies the result into the returned dynamic
 * view.  The ELSE arm is the exact pre-existing call lowering for a plain
 * externref receiver.
 */
function emitDynViewSpeciesMethodTwoArm(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  receiverType: ts.Type | undefined,
  methodName: string,
  expectedType: ValType | undefined,
): ValType | null | undefined | typeof VOID_RESULT {
  const receiverExpr = propAccess.expression;
  if (!ts.isIdentifier(receiverExpr)) return undefined;
  const name = receiverExpr.text;
  const dynIdx = getOrRegisterTaDynViewType(ctx);

  const rt = compileExpression(ctx, fctx, receiverExpr);
  if (rt && rt.kind !== "externref") coerceType(ctx, fctx, rt, { kind: "externref" });
  const recvExt = allocLocal(fctx, `__dvs_recv_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: recvExt });
  const recvAny = allocLocal(fctx, `__dvs_any_${fctx.locals.length}`, { kind: "anyref" });
  fctx.body.push(
    { op: "local.get", index: recvExt },
    { op: "any.convert_extern" },
    { op: "local.set", index: recvAny },
  );

  const dvLocal = allocLocal(fctx, `__dvs_dv_${fctx.locals.length}`, { kind: "ref", typeIdx: dynIdx });
  const outer = fctx.body;
  const thenArm: Instr[] = [];
  const elseArm: Instr[] = [];
  fctx.savedBodies.push(outer, thenArm, elseArm);

  const abandon = (): undefined => {
    fctx.body = outer;
    fctx.savedBodies.pop();
    fctx.savedBodies.pop();
    fctx.savedBodies.pop();
    return undefined;
  };

  fctx.body = thenArm;
  fctx.body.push(
    { op: "local.get", index: recvAny },
    { op: "ref.cast", typeIdx: dynIdx },
    { op: "local.set", index: dvLocal },
  );
  emitTaDynViewValidate(ctx, fctx, dvLocal);
  const f64VecIdx = emitTaDynViewToVec(ctx, fctx, dvLocal);
  const matLocal = allocLocal(fctx, `__dvs_mat_${fctx.locals.length}`, { kind: "ref", typeIdx: f64VecIdx });
  fctx.body.push({ op: "local.set", index: matLocal });

  const boxNumIdx = ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
  if (boxNumIdx === undefined) return abandon();

  const boxI32 = (valueLocal: number, tag: string): number => {
    const out = allocLocal(fctx, `__dvs_${tag}_${fctx.locals.length}`, { kind: "externref" });
    fctx.body.push(
      { op: "local.get", index: valueLocal },
      { op: "f64.convert_i32_s" },
      { op: "call", funcIdx: boxNumIdx },
      { op: "local.set", index: out },
    );
    return out;
  };

  const bindSpeciesResult = (speciesLocal: number): number => {
    const anyLocal = allocLocal(fctx, `__dvs_species_any_${fctx.locals.length}`, { kind: "anyref" });
    const resultDv = allocLocal(fctx, `__dvs_species_dv_${fctx.locals.length}`, { kind: "ref", typeIdx: dynIdx });
    fctx.body.push(
      { op: "local.get", index: speciesLocal },
      { op: "any.convert_extern" },
      { op: "local.set", index: anyLocal },
      { op: "local.get", index: anyLocal },
      { op: "ref.cast", typeIdx: dynIdx },
      { op: "local.set", index: resultDv },
    );
    return resultDv;
  };

  const captureVec = (
    r: ValType | null | undefined | typeof VOID_RESULT,
    tag: string,
  ): { local: number; typeIdx: number; elemType: ValType; lenLocal: number } | undefined => {
    if (!r || r === VOID_RESULT || (r.kind !== "ref" && r.kind !== "ref_null") || !("typeIdx" in r)) return undefined;
    const typeIdx = r.typeIdx;
    const arrIdx = getArrTypeIdxFromVec(ctx, typeIdx);
    const arrDef = arrIdx < 0 ? undefined : ctx.mod.types[arrIdx];
    if (!arrDef || arrDef.kind !== "array") return undefined;
    const local = allocLocal(fctx, `__dvs_${tag}_${fctx.locals.length}`, r);
    fctx.body.push({ op: "local.set", index: local });
    const lenLocal = allocLocal(fctx, `__dvs_${tag}_len_${fctx.locals.length}`, { kind: "i32" });
    fctx.body.push(
      { op: "local.get", index: local },
      { op: "struct.get", typeIdx, fieldIdx: 0 },
      { op: "local.set", index: lenLocal },
    );
    return { local, typeIdx, elemType: arrDef.element, lenLocal };
  };

  const copySpeciesResult = (
    speciesLocal: number,
    source: { local: number; typeIdx: number; elemType: ValType; lenLocal: number },
    countLocal: number,
  ): void => {
    const resultDv = bindSpeciesResult(speciesLocal);
    emitTaDynViewWriteF64Vec(ctx, fctx, resultDv, source.local, source.typeIdx, source.elemType, countLocal);
  };

  const compileMaterializedMethod = () =>
    withArraySpeciesSuppressed(fctx, () =>
      compileArrayMethodCall(ctx, fctx, propAccess, callExpr, receiverType, methodName, expectedType, true),
    );

  let outputSpecies: number | undefined;
  if (methodName === "map") {
    const sourceLen = allocLocal(fctx, `__dvs_map_len_${fctx.locals.length}`, { kind: "i32" });
    fctx.body.push(
      { op: "local.get", index: matLocal },
      { op: "struct.get", typeIdx: f64VecIdx, fieldIdx: 0 },
      { op: "local.set", index: sourceLen },
    );
    const countArg = boxI32(sourceLen, "map_count");
    outputSpecies =
      emitTaDynSpeciesCreate(ctx, fctx, { dvLocal, argLocals: [countArg], requestedLengthLocal: sourceLen }) ??
      undefined;
    if (outputSpecies === undefined) return abandon();
    const savedBind = fctx.localMap.get(name);
    fctx.localMap.set(name, matLocal);
    const r = compileMaterializedMethod();
    if (savedBind !== undefined) fctx.localMap.set(name, savedBind);
    else fctx.localMap.delete(name);
    const mapped = captureVec(r, "map_result");
    if (!mapped) return abandon();
    copySpeciesResult(outputSpecies, mapped, sourceLen);
  } else if (methodName === "filter") {
    const savedBind = fctx.localMap.get(name);
    fctx.localMap.set(name, matLocal);
    const r = compileMaterializedMethod();
    if (savedBind !== undefined) fctx.localMap.set(name, savedBind);
    else fctx.localMap.delete(name);
    const filtered = captureVec(r, "filter_result");
    if (!filtered) return abandon();
    outputSpecies =
      emitTaDynSpeciesCreate(ctx, fctx, {
        dvLocal,
        argLocals: [boxI32(filtered.lenLocal, "filter_count")],
        requestedLengthLocal: filtered.lenLocal,
      }) ?? undefined;
    if (outputSpecies === undefined) return abandon();
    copySpeciesResult(outputSpecies, filtered, filtered.lenLocal);
  } else if (methodName === "slice") {
    const savedBind = fctx.localMap.get(name);
    fctx.localMap.set(name, matLocal);
    const r = compileMaterializedMethod();
    if (savedBind !== undefined) fctx.localMap.set(name, savedBind);
    else fctx.localMap.delete(name);
    const sliced = captureVec(r, "slice_result");
    if (!sliced) return abandon();
    outputSpecies =
      emitTaDynSpeciesCreate(ctx, fctx, {
        dvLocal,
        argLocals: [boxI32(sliced.lenLocal, "slice_count")],
        requestedLengthLocal: sliced.lenLocal,
      }) ?? undefined;
    if (outputSpecies === undefined) return abandon();
    copySpeciesResult(outputSpecies, sliced, sliced.lenLocal);
  } else {
    // subarray: the method does not materialize/copy. Compute the normalized
    // element window, then pass the backing buffer and byte tuple to species.
    const sourceLen = allocLocal(fctx, `__dvs_sub_len_${fctx.locals.length}`, { kind: "i32" });
    fctx.body.push(
      { op: "local.get", index: matLocal },
      { op: "struct.get", typeIdx: f64VecIdx, fieldIdx: 0 },
      { op: "local.set", index: sourceLen },
    );
    const begin = allocLocal(fctx, `__dvs_sub_begin_${fctx.locals.length}`, { kind: "i32" });
    const end = allocLocal(fctx, `__dvs_sub_end_${fctx.locals.length}`, { kind: "i32" });
    if (callExpr.arguments.length >= 1) {
      compileExpression(ctx, fctx, callExpr.arguments[0]!, { kind: "f64" });
      fctx.body.push({ op: "i32.trunc_sat_f64_s" });
    } else fctx.body.push({ op: "i32.const", value: 0 });
    fctx.body.push({ op: "local.set", index: begin });
    emitClampIndex(fctx, begin, sourceLen);
    const endArg = callExpr.arguments.length >= 2 ? callExpr.arguments[1]! : undefined;
    const endUndefined = endArg !== undefined && ts.isIdentifier(endArg) && endArg.text === "undefined";
    if (endArg !== undefined && !endUndefined) {
      compileExpression(ctx, fctx, endArg, { kind: "f64" });
      fctx.body.push({ op: "i32.trunc_sat_f64_s" }, { op: "local.set", index: end });
      emitClampIndex(fctx, end, sourceLen);
    } else {
      fctx.body.push({ op: "local.get", index: sourceLen }, { op: "local.set", index: end });
    }
    const subLen = allocLocal(fctx, `__dvs_sub_count_${fctx.locals.length}`, { kind: "i32" });
    fctx.body.push(
      { op: "local.get", index: end },
      { op: "local.get", index: begin },
      { op: "i32.sub" },
      { op: "local.set", index: subLen },
    );
    emitClampNonNeg(fctx, subLen);
    const kind = allocLocal(fctx, `__dvs_sub_kind_${fctx.locals.length}`, { kind: "i32" });
    const elemSize = allocLocal(fctx, `__dvs_sub_es_${fctx.locals.length}`, { kind: "i32" });
    const byteOffset = allocLocal(fctx, `__dvs_sub_off_${fctx.locals.length}`, { kind: "i32" });
    fctx.body.push(
      { op: "local.get", index: dvLocal },
      { op: "struct.get", typeIdx: dynIdx, fieldIdx: 3 },
      { op: "local.set", index: kind },
    );
    pushElemSizeForKind(fctx, kind);
    fctx.body.push(
      { op: "local.set", index: elemSize },
      { op: "local.get", index: dvLocal },
      { op: "struct.get", typeIdx: dynIdx, fieldIdx: 2 },
      { op: "local.get", index: begin },
      { op: "local.get", index: elemSize },
      { op: "i32.mul" },
      { op: "i32.add" },
      { op: "local.set", index: byteOffset },
    );
    const bufferArg = allocLocal(fctx, `__dvs_sub_buffer_${fctx.locals.length}`, { kind: "externref" });
    fctx.body.push(
      { op: "local.get", index: dvLocal },
      { op: "struct.get", typeIdx: dynIdx, fieldIdx: 1 },
      { op: "extern.convert_any" },
      { op: "local.set", index: bufferArg },
    );
    outputSpecies =
      emitTaDynSpeciesCreate(ctx, fctx, {
        dvLocal,
        argLocals: [bufferArg, boxI32(byteOffset, "sub_offset"), boxI32(subLen, "sub_length")],
      }) ?? undefined;
    if (outputSpecies === undefined) return abandon();
  }

  // The branch result is the species-created view after any producer copy.
  // Keep the full dynamic arm in the `if` so creation and validation execute
  // only for a dynamic view, then leave the constructed view on its value
  // stack for the enclosing call expression.
  if (outputSpecies === undefined) return undefined;
  thenArm.push({ op: "local.get", index: outputSpecies });

  fctx.body = elseArm;
  dynViewTwoArmActive.add(callExpr);
  const rElse = compileExpression(ctx, fctx, callExpr, expectedType);
  dynViewTwoArmActive.delete(callExpr);
  const elseOk = coerceArmToExternref(ctx, fctx, rElse, true);
  fctx.body = outer;
  fctx.savedBodies.pop();
  fctx.savedBodies.pop();
  fctx.savedBodies.pop();
  if (!elseOk) return undefined;
  outer.push(
    { op: "local.get", index: recvAny },
    { op: "ref.test", typeIdx: dynIdx },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "externref" } },
      then: thenArm,
      else: elseArm,
    },
  );
  return { kind: "externref" };
}

/** Entry point for the earlier any/externref receiver dispatcher. */
export function tryCompileDynViewSpeciesMethodCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  receiverType: ts.Type,
  expectedType?: ValType,
): ValType | null | undefined | typeof VOID_RESULT {
  const methodName = propAccess.name.text;
  if (!shouldWrapDynViewSpeciesTwoArm(ctx, fctx, propAccess, callExpr, methodName, false)) return undefined;
  return emitDynViewSpeciesMethodTwoArm(ctx, fctx, propAccess, callExpr, receiverType, methodName, expectedType);
}

function emitDynViewMethodTwoArm(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  callExpr: ts.CallExpression,
  receiverType: ts.Type | undefined,
  methodName: string,
  expectedType: ValType | undefined,
): ValType | null | undefined | typeof VOID_RESULT {
  const receiverExpr = propAccess.expression;
  if (!ts.isIdentifier(receiverExpr)) return undefined;
  const name = receiverExpr.text;
  // (#3162 Fix B) Pre-ensure the standalone native `__hof_<name>` loop for
  // find/findIndex BEFORE emitting any arm/receiver code, so the append-only
  // defined-func mint (and any union-import registration it triggers) settles
  // the funcIdx space up front — nothing is buffered yet to be shifted (mirrors
  // the setupArrayLoop pre-flush discipline). undefined ⇒ helper unavailable
  // (non-standalone or missing deps): the THEN arm falls back to the legacy
  // `compileArrayMethodCall` re-entry.
  const hofMethodIdx =
    ctx.standalone && FIND_METHODS.has(methodName) ? ensureNativeArrayHof(ctx, methodName) : undefined;
  const dynIdx = getOrRegisterTaDynViewType(ctx);

  // Compile the receiver ONCE → externref → recvExt; recvAny (anyref) for ref.test/cast.
  const rt = compileExpression(ctx, fctx, receiverExpr);
  if (rt && rt.kind !== "externref") coerceType(ctx, fctx, rt, { kind: "externref" });
  const recvExt = allocLocal(fctx, `__dvm_recv_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: recvExt });
  const recvAny = allocLocal(fctx, `__dvm_any_${fctx.locals.length}`, { kind: "anyref" } as ValType);
  fctx.body.push({ op: "local.get", index: recvExt });
  fctx.body.push({ op: "any.convert_extern" });
  fctx.body.push({ op: "local.set", index: recvAny });

  const dvLocal = allocLocal(fctx, `__dvm_dv_${fctx.locals.length}`, { kind: "ref", typeIdx: dynIdx });

  const outer = fctx.body;
  const thenArm: Instr[] = [];
  const elseArm: Instr[] = [];
  fctx.savedBodies.push(outer);
  fctx.savedBodies.push(thenArm);
  fctx.savedBodies.push(elseArm);

  // --- THEN arm (dyn view) ---
  fctx.body = thenArm;
  fctx.body.push({ op: "local.get", index: recvAny });
  fctx.body.push({ op: "ref.cast", typeIdx: dynIdx });
  fctx.body.push({ op: "local.set", index: dvLocal });
  emitTaDynViewValidate(ctx, fctx, dvLocal);
  const f64VecIdx = emitTaDynViewToVec(ctx, fctx, dvLocal);
  const matLocal = allocLocal(fctx, `__dvm_mat_${fctx.locals.length}`, { kind: "ref", typeIdx: f64VecIdx });
  fctx.body.push({ op: "local.set", index: matLocal });
  let rThen: ValType | null | undefined | typeof VOID_RESULT;
  if (hofMethodIdx !== undefined) {
    // (#3162 Fix B) find/findIndex over the materialized `$__vec_f64`: route
    // through the #3098 native `__hof_<name>(recv, cb, thisArg) -> externref`
    // loop instead of re-entering `compileArrayFind` (whose f64-vec impl boxes a
    // NaN "not found" sentinel and drops thisArg). `__extern_get_idx` accepts a
    // real `$__vec_*` receiver, so the materialized vec crosses as externref;
    // the helper returns element/index/undefined as externref — already the
    // unified branch rep (no `coerceArmToExternref` fixup). The callback is
    // compiled once per arm (the ELSE arm re-dispatch mints it again — tolerated
    // double-mint, same as reduce/reduceRight; not a soundness bug).
    const pushExt = (arg: ts.Expression, asClosure: boolean): void => {
      const at =
        asClosure && (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg))
          ? compileArrowAsClosure(ctx, fctx, arg)
          : compileExpression(ctx, fctx, arg, { kind: "externref" });
      if (at && at.kind !== "externref") coerceType(ctx, fctx, at, { kind: "externref" });
      else if (at === null) fctx.body.push({ op: "ref.null.extern" });
    };
    fctx.body.push({ op: "local.get", index: matLocal });
    fctx.body.push({ op: "extern.convert_any" }); // recv
    pushExt(callExpr.arguments[0]!, true); // cb
    if (callExpr.arguments.length >= 2)
      pushExt(callExpr.arguments[1]!, false); // thisArg
    else fctx.body.push({ op: "ref.null.extern" }); // thisArg = undefined
    fctx.body.push({ op: "call", funcIdx: hofMethodIdx });
    rThen = { kind: "externref" };
  } else {
    const savedBind = fctx.localMap.get(name);
    fctx.localMap.set(name, matLocal);
    rThen = compileArrayMethodCall(ctx, fctx, propAccess, callExpr, receiverType, methodName, expectedType, true);
    if (savedBind !== undefined) fctx.localMap.set(name, savedBind);
    else fctx.localMap.delete(name);
  }
  const thenOk = coerceArmToExternref(ctx, fctx, rThen, false, BOOLEAN_RESULT_METHODS.has(methodName));

  // --- ELSE arm (exact existing non-dyn-view impl) — re-dispatch the WHOLE call
  // through compileExpression so the caller's host/externref fallback (which lives
  // ABOVE compileArrayMethodCall) runs verbatim. The `dynViewTwoArmActive` guard
  // stops the re-dispatch from re-entering this two-arm.
  fctx.body = elseArm;
  dynViewTwoArmActive.add(callExpr);
  const rElse = compileExpression(ctx, fctx, callExpr, expectedType);
  dynViewTwoArmActive.delete(callExpr);
  const elseOk = coerceArmToExternref(ctx, fctx, rElse, /* treatNullAsVoid */ true);

  fctx.body = outer;
  fctx.savedBodies.pop(); // elseArm
  fctx.savedBodies.pop(); // thenArm
  fctx.savedBodies.pop(); // outer

  if (!thenOk || !elseOk) {
    // Arm 1 declined — abandon the two-arm. The recvExt/recvAny setup already emitted
    // into `outer` is stack-balanced (local.set/get pairs) and merely a dead store;
    // the caller re-compiles the receiver on the ordinary single path.
    return undefined;
  }

  outer.push({ op: "local.get", index: recvAny });
  outer.push({ op: "ref.test", typeIdx: dynIdx });
  outer.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "externref" } },
    then: thenArm,
    else: elseArm,
  });
  return { kind: "externref" };
}

function shouldUseHostArrayMethod(ctx: CodegenContext, receiverIsExternref: boolean): boolean {
  return receiverIsExternref && !ctx.standalone && !ctx.wasi;
}

/**
 * Compile array method calls to inline Wasm instructions.
 * Returns undefined if the call is not an array method (caller should continue).
 * Returns ValType for successful compilation, VOID_RESULT for void methods,
 * or null for failed compilation.
 */
export function compileArrayMethodCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  callExpr: ts.CallExpression,
  receiverType: ts.Type | undefined,
  overrideMethodName?: string,
  expectedType?: ValType,
  skipDynViewWrap = false,
): ValType | null | undefined | typeof VOID_RESULT {
  const methodName =
    overrideMethodName ?? (ts.isPropertyAccessExpression(propAccess) ? propAccess.name.text : undefined);
  if (!methodName || !ARRAY_METHODS.has(methodName)) return undefined;

  if (shouldWrapDynViewSpeciesTwoArm(ctx, fctx, propAccess, callExpr, methodName, skipDynViewWrap)) {
    const species = emitDynViewSpeciesMethodTwoArm(
      ctx,
      fctx,
      propAccess as ts.PropertyAccessExpression,
      callExpr,
      receiverType,
      methodName,
      expectedType,
    );
    if (species !== undefined) return species;
  }

  // (#3058) Runtime-kind proto-method dispatch on a boxed `$__ta_dyn_view` receiver
  // (dynamic `new <ctorVar>(rab)` where the element kind is only known at runtime).
  // A read-side Bucket-A method on such a view must (1) ValidateTypedArray (OOB →
  // TypeError) and (2) run over a materialized f64-vec copy. Because the receiver is
  // statically `any`/externref, its dyn-view-ness is a RUNTIME `ref.test`, NOT a
  // compile-time fact — so we emit a two-arm branch that wraps BOTH the dyn-view
  // f64-vec impl and the EXACT existing externref/plain-array impl (never hijacks a
  // plain-array `any` receiver). See emitDynViewMethodTwoArm.
  if (shouldWrapDynViewTwoArm(ctx, fctx, propAccess, callExpr, methodName, skipDynViewWrap)) {
    const two = emitDynViewMethodTwoArm(ctx, fctx, propAccess, callExpr, receiverType, methodName, expectedType);
    if (two !== undefined) return two;
    // Fell through (arm compile declined) — continue with the ordinary single path.
  }
  // (#4556 bucket A) A user override of `Array.prototype.<m>` wins over the
  // builtin lowering — see builtin-proto-member-override.ts.
  const ovr = tryEmitProtoOverrideTwoArm(ctx, fctx, propAccess, callExpr, "Array", methodName, expectedType);
  if (ovr !== undefined) return ovr;
  // (#2863 Phase 2) `toLocaleString` is array-dispatched ONLY under standalone/
  // wasi (no host `__extern_toLocaleString` carrier). In host (gc) mode fall
  // through to the host `__extern_toLocaleString` path (real Intl grouping +
  // per-element abrupt-completion propagation) — return undefined here.
  if (methodName === "toLocaleString" && !ctx.standalone && !ctx.wasi) return undefined;

  // (#2007/#1448) Record closure-allocating array methods so the standalone
  // vec-concat join fast-path can avoid a late `number_toString` registration
  // that would shift indices and corrupt this closure's already-emitted code.
  if (
    methodName === "map" ||
    methodName === "filter" ||
    methodName === "flatMap" ||
    methodName === "forEach" ||
    methodName === "reduce" ||
    methodName === "reduceRight" ||
    methodName === "find" ||
    methodName === "findIndex" ||
    methodName === "sort"
  ) {
    fctx.emittedClosureArrayMethod = true;
  }

  const receiverExpr = propAccess.expression;
  const arrInfo =
    (receiverType === undefined ? null : resolveArrayInfo(ctx, receiverType)) ??
    resolveArrayInfoFromWasmType(ctx, inferExpressionWasmType(ctx, fctx, receiverExpr, receiverType === undefined));
  if (!arrInfo) return undefined;

  // A native-string join over a closure-producing array expression must
  // compile that receiver exactly once. The ordinary actual-type probe below
  // recompiles `map`/`filter`/… and closure registration is not transactional;
  // probing and then emitting the receiver can therefore leave the committed
  // call wired to a stale/null closure. The resolved TS result type already
  // describes the array produced by these methods, including `map`'s result
  // element type, so use it directly for this narrow nested-call shape.
  const skipReceiverProbeForNativeJoin =
    ctx.nativeStrings &&
    (methodName === "join" || methodName === "toString" || methodName === "toLocaleString") &&
    receiverIsClosureProducingArrayCall(receiverExpr);

  let { vecTypeIdx, arrTypeIdx, elemType } = arrInfo;
  // #1286: tracks whether the probe found the receiver to be externref at
  // runtime (e.g., the result of `Object.keys(any)`, which goes through the
  // `__object_keys` host import). The `case "join":` dispatch below routes
  // through `compileArrayJoinExtern` whenever this is set so the WasmGC-
  // native loop doesn't try to extract a vec struct from a JS array.
  let receiverIsExternref = false;
  // (#3054 B1 Option A) When the receiver is a `$__ta_view` (shared-backing TA
  // over a buffer), it can't be `ref.cast` to the native element-typed vec the
  // method operates on. We materialize the view into a native vec and rebind the
  // receiver identifier; these hold the rebind so we can restore it post-dispatch.
  let taViewRebindName: string | undefined;
  let taViewRebindSaved: number | undefined;
  // (#3054 B3) write-through: after a MUTATING method runs on the de-viewed
  // native-vec copy, byte-encode it back into the view's shared buffer. Capture
  // the view typeIdx, the original view local, the native-vec copy local and its
  // vec typeIdx so `emitTaViewWriteBack` can round-trip the mutation.
  let taViewWbTypeIdx: number | undefined;
  let taViewWbViewLocal: number | undefined;
  let taViewWbMatLocal: number | undefined;
  let taViewWbNativeVecIdx: number | undefined;

  // The receiver's actual Wasm type may differ from the TS type — e.g.
  // `[0, true].lastIndexOf(...)` infers i32 elements during construction,
  // but resolveArrayInfo resolves (number|boolean)[] → __vec_externref.
  // Probe-compile the receiver to determine the actual Wasm type (#826).
  if (receiverExpr && !skipReceiverProbeForNativeJoin) {
    // Fast path: check the Wasm local/global type directly
    let actualType: ValType | undefined;
    if (ts.isIdentifier(receiverExpr)) {
      const name = receiverExpr.text;
      const localIdx = fctx.localMap.get(name);
      if (localIdx !== undefined) {
        // #1247: localIdx is the wasm-level index (params + locals);
        // `fctx.locals` indexes only locals (no params). Use getLocalType
        // to handle the offset correctly. Without this, in functions with
        // params, `paths.shift()` looks up the wrong local and dispatches
        // through a stale vec type idx, producing struct-type mismatches
        // at instantiation.
        actualType = getLocalType(fctx, localIdx);
      } else {
        const gIdx = ctx.moduleGlobals.get(name);
        if (gIdx !== undefined) {
          const globalDef = ctx.mod.globals[localGlobalIdx(ctx, gIdx)];
          actualType = globalDef?.type;
        }
      }
    }
    // Slow path: probe-compile the receiver to determine its actual type.
    // Compiles the expression, captures the result type, then rolls back.
    if (!actualType || actualType.kind === "externref" || actualType.kind === "f64" || actualType.kind === "i32") {
      // #1919 — transactional probe: the method function re-compiles the
      // receiver below, so discard the body plus any locals / late imports /
      // errors this probe leaks.
      const probeResult = probeCompiledType(ctx, fctx, () => compileExpression(ctx, fctx, receiverExpr));
      if (
        probeResult &&
        (probeResult.kind === "ref" || probeResult.kind === "ref_null") &&
        (probeResult as any).typeIdx !== undefined
      ) {
        actualType = probeResult;
      } else if (probeResult && probeResult.kind === "externref") {
        // Capture externref-shaped receivers too — `Object.keys(any).join(...)` and
        // similar host-import-returning calls hit this branch (#1286). The
        // existing struct-vec dispatch below ignores this case (it only updates
        // vecTypeIdx for known ref types), but `case "join":` consults this flag
        // to route through the host-import fallback.
        actualType = probeResult;
        receiverIsExternref = true;
      }
    }
    // Catch the fast-path case too: an identifier whose declared local/global
    // type is externref (e.g., a parameter typed `any`). The slow-path probe
    // above only runs when the fast-path lookup is ambiguous.
    if (actualType && actualType.kind === "externref") {
      receiverIsExternref = true;
    }
    if (
      actualType &&
      (actualType.kind === "ref" || actualType.kind === "ref_null") &&
      (actualType as { typeIdx: number }).typeIdx !== vecTypeIdx
    ) {
      const actualVecIdx = (actualType as { typeIdx: number }).typeIdx;
      // A buffer-backed TypedArray must keep `subarray` on the SAME byte buffer.
      // Materializing it into the ordinary element vec first (the generic method
      // bridge below) makes the subview alias that temporary copy and resets its
      // byteOffset to zero. Build a sibling `$__ta_view` directly instead.
      if (
        methodName === "subarray" &&
        isTaViewTypeIdx(ctx, actualVecIdx) &&
        ts.isIdentifier(receiverExpr) &&
        fctx.localMap.has(receiverExpr.text)
      ) {
        return compileTaViewSubarray(ctx, fctx, propAccess, callExpr, actualVecIdx);
      }
      // (#3054 B1 Option A) `$__ta_view` receiver: materialize into the native
      // element-typed vec (`vecTypeIdx`, from `resolveArrayInfo`) and rebind the
      // identifier so the method's receiver re-compile loads the copy instead of
      // ref.cast-trapping on the view. Only the identifier-local case (the
      // measured regression: `ta.fill(...)`/`ta.includes(...)`); other receiver
      // shapes are rarer and fall through unchanged.
      if (isTaViewTypeIdx(ctx, actualVecIdx) && ts.isIdentifier(receiverExpr) && fctx.localMap.has(receiverExpr.text)) {
        // ValidateTypedArray is the first step of every TypedArray prototype
        // method.  The shared-backing view is otherwise materialized into an
        // ordinary vector, which would hide a detached/OOB backing buffer and
        // let argument coercion run before the required TypeError.
        const originalViewLocal = fctx.localMap.get(receiverExpr.text);
        if (originalViewLocal !== undefined) {
          emitTaViewValidate(ctx, fctx, actualVecIdx, originalViewLocal);
        }
        const matLocal = allocLocal(fctx, `__tav_mrecv_${fctx.locals.length}`, {
          kind: "ref_null",
          typeIdx: vecTypeIdx,
        });
        compileExpression(ctx, fctx, receiverExpr); // loads the view ref
        emitTaViewToVec(ctx, fctx, actualVecIdx, vecTypeIdx); // → native vec
        fctx.body.push({ op: "local.set", index: matLocal });
        taViewRebindName = receiverExpr.text;
        taViewRebindSaved = fctx.localMap.get(receiverExpr.text);
        fctx.localMap.set(receiverExpr.text, matLocal);
        // (#3054 B3) remember the pieces needed to write the copy back through
        // the view's buffer after a mutating method. `taViewRebindSaved` is the
        // original view local (the shared-backing `$__ta_view` ref).
        taViewWbTypeIdx = actualVecIdx;
        taViewWbViewLocal = taViewRebindSaved;
        taViewWbMatLocal = matLocal;
        taViewWbNativeVecIdx = vecTypeIdx;
      } else {
        const actualArrIdx = getArrTypeIdxFromVec(ctx, actualVecIdx);
        if (actualArrIdx >= 0) {
          const actualArrDef = ctx.mod.types[actualArrIdx];
          if (actualArrDef && actualArrDef.kind === "array") {
            vecTypeIdx = actualVecIdx;
            arrTypeIdx = actualArrIdx;
            elemType = actualArrDef.element;
          }
        }
      }
    }
  }

  const methodAccess = propAccess as ts.PropertyAccessExpression;

  // If receiver is a module global, proxy it through a temp local so
  // getReceiverLocalIdx succeeds. Array methods mutate the vec/backing in
  // place, so the global reference itself never needs to be written back.
  let moduleGlobalIdx: number | undefined;
  let savedLocal: number | undefined;
  // #1966: `unshift` mutates in place (prepends + shifts), so its mutated vec
  // must be written back to the receiver — include it here. The `to*`
  // variants (toSorted/toReversed/toSpliced/with) and slice/concat/map/filter
  // are NON-mutating (they return a new array) and are deliberately excluded.
  const MUTATING = new Set([
    "push",
    "pop",
    "shift",
    "unshift",
    "reverse",
    "splice",
    "fill",
    "copyWithin",
    "sort",
    "set",
  ]);
  if (ts.isIdentifier(propAccess.expression)) {
    const name = propAccess.expression.text;
    const gIdx = ctx.moduleGlobals.get(name);
    if (gIdx !== undefined && !fctx.localMap.has(name)) {
      moduleGlobalIdx = gIdx;
      const globalDef = ctx.mod.globals[localGlobalIdx(ctx, gIdx)];
      if (!globalDef) return null;
      const tempLocal = allocLocal(fctx, `__mod_proxy_${name}`, globalDef.type);
      fctx.body.push({ op: "global.get", index: gIdx });
      fctx.body.push({ op: "local.set", index: tempLocal });
      fctx.localMap.set(name, tempLocal);
      savedLocal = tempLocal;
    }
  }

  // (#3126, #3098 typed-lane residual) Element-kind gate for the callback-
  // consuming HOF impls below. f64/i32/externref were always admitted;
  // ref/ref_null (native-string / object-struct) elements are admitted on the
  // HOST-FREE lanes (standalone/wasi) when the callback provably takes the
  // native closure path (see refElemHofCallbackIsClosure). There the generic
  // fallback is strictly unusable — it materializes the callback via
  // `env.__make_callback`, an unsatisfiable host import (typed `string[]`
  // find/filter — the #3098 boundary), so routing native can only gain.
  //
  // The gc HOST lane is deliberately NOT widened. Its fallback compiles the
  // inline arrow via compileArrowAsCallback (`__make_callback`), whose body
  // resolves HOST globals (`Temporal`, `TemporalHelpers`, …) and host-object
  // method calls; the closure path (compileArrowAsClosure) does not — a
  // widened gc gate flipped 212 Temporal merge_group tests pass→fail
  // ("TemporalHelpers is not defined" inside the lifted closure) on PR #2838's
  // first merge-group attempt. The gc-lane residual (struct-array `T[]`
  // find/filter/some are a silent no-op through the SAME fallback when the
  // body is host-free) stays pre-existing and documented in the #3126 issue
  // file — its real root is closure-lifted host-global resolution, not this
  // gate. Mirrors the #1967 `sort` / #2688 `map` widenings otherwise.
  // Evaluated lazily: at most one probe-compile per call site, only for
  // ref-element receivers on the host-free lanes.
  const hofElemKindOk = (et: ValType): boolean =>
    et.kind === "f64" ||
    et.kind === "i32" ||
    et.kind === "externref" ||
    ((et.kind === "ref" || et.kind === "ref_null") &&
      refElemHofCallbackIsClosure(ctx, fctx, callExpr) &&
      // (#4616) gc HOST lane: widen only for callbacks whose body is free of
      // host-only ambient globals — the #2838 Temporal hazard. The standalone/
      // wasi lanes keep their unconditional widening (no host globals exist).
      (ctx.standalone || ctx.wasi || hofRefElemClosureLaneSafe(ctx, callExpr)));

  // (#3481) §23.1.3.1 `at(index)` step 3 and §23.1.3.14 `includes(x, fromIndex)`
  // step 4 both run `? ToIntegerOrInfinity(...)`, whose ToNumber throws on a
  // Symbol (§7.1.4 step 5). Both have TWO lowerings (native vec and the host
  // fallback) that each read the argument as a number, so a symbol's `i32` id
  // flowed through as an ordinary index — `[1,2].at(Symbol())` answered
  // `undefined` instead of throwing. Guarding at the shared dispatch covers
  // both arms once; the receiver is passed as a `before` operand so its side
  // effects still run in §13.3.6.1 order.
  {
    const symbolIndexArg = methodName === "at" ? 0 : methodName === "includes" ? 1 : -1;
    const indexArg = symbolIndexArg < 0 ? undefined : callExpr.arguments[symbolIndexArg];
    if (
      indexArg !== undefined &&
      emitSymbolOperandCoercionThrow(ctx, fctx, indexArg, "number", [
        methodAccess.expression,
        ...callExpr.arguments.slice(0, symbolIndexArg),
      ])
    ) {
      return methodName === "includes" ? { kind: "i32" } : { kind: "externref" };
    }
  }

  let result: ValType | null | undefined;
  switch (methodName) {
    case "indexOf": {
      const identityLength = canonicalIdentityArrayLength(ctx, methodAccess.expression, callExpr);
      const search = callExpr.arguments[0];
      const range = search ? staticIntegerRange(ctx, search) : undefined;
      if (
        identityLength !== undefined &&
        callExpr.arguments.length === 1 &&
        range !== undefined &&
        range.min >= 0 &&
        range.max < identityLength
      ) {
        if (!tryEmitStaticI32Expression(ctx, fctx, search!)) {
          const searchType = compileExpression(ctx, fctx, search!, { kind: "i32" });
          if (searchType && searchType.kind !== "i32") coerceType(ctx, fctx, searchType, { kind: "i32" });
        }
        if (ctx.fast) {
          result = { kind: "i32" };
        } else {
          fctx.body.push({ op: "f64.convert_i32_s" });
          result = { kind: "f64" };
        }
      } else {
        result = compileArrayIndexOf(ctx, fctx, methodAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType);
      }
      break;
    }
    case "includes":
      // A callback capture is deliberately kept as externref even when the
      // checker narrows it to `string[]`.  The host may hand that capture back
      // as a proxy/raw externref whose concrete WasmGC vec type is not the
      // statically inferred one; the native vec loop would then ref.cast and
      // trap.  Route that dynamic receiver through the existing host method
      // bridge, which materializes/dispatches the array without a typed cast.
      result = receiverIsExternref
        ? compileArrayMethodExtern(ctx, fctx, methodAccess, callExpr, "includes")
        : compileArrayIncludes(ctx, fctx, methodAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType);
      break;
    case "reverse":
      result = shouldUseHostArrayMethod(ctx, receiverIsExternref)
        ? compileArrayMethodExtern(ctx, fctx, methodAccess, callExpr, "reverse")
        : compileArrayReverse(ctx, fctx, methodAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType);
      break;
    case "push":
      result = tryCompileArrayPushDynamicSpread(
        ctx,
        fctx,
        methodAccess,
        callExpr,
        receiverIsExternref,
        vecTypeIdx,
        arrTypeIdx,
        elemType,
      );
      if (result !== undefined) break;
      // (#4531) An externref-shaped receiver (a class FIELD holding what may
      // be a `__make_iterable` host mirror — prettier's `this.stack`) must not
      // take the native inline push, whose receiver coercion `ref.cast`s to
      // the statically inferred vec and traps `illegal cast` on the mirror.
      // Emit the #2784-style guarded dual-lane instead: `ref.test` the vec
      // carriers → native `__vec_push`, else the host `__extern_method_call`
      // bridge (whose `_tryWasmVecMutation` routes a registered mirror back to
      // its source vec). Host/gc lane only — standalone and native-first keep
      // the native path (no host mirrors exist there).
      if (
        receiverIsExternref &&
        !ctx.standalone &&
        !ctx.wasi &&
        ctx.targetProfile.semanticProviders !== "native-first" &&
        callExpr.arguments.length === 1
      ) {
        result = compileExternReceiverPushPop(ctx, fctx, methodAccess, callExpr, "push");
        if (result !== undefined) break;
      }
      result = compileArrayPush(ctx, fctx, methodAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType);
      break;
    case "pop":
      // (#4531) Same dual-lane as `push` — see above.
      if (
        receiverIsExternref &&
        !ctx.standalone &&
        !ctx.wasi &&
        ctx.targetProfile.semanticProviders !== "native-first" &&
        callExpr.arguments.length === 0
      ) {
        result = compileExternReceiverPushPop(ctx, fctx, methodAccess, callExpr, "pop");
        if (result !== undefined) break;
      }
      result = compileArrayPop(ctx, fctx, methodAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType, expectedType);
      break;
    case "shift":
      result = compileArrayShift(ctx, fctx, methodAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType, expectedType);
      break;
    case "unshift":
      result = compileArrayUnshift(ctx, fctx, methodAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType);
      break;
    case "slice":
      result = shouldUseHostArrayMethod(ctx, receiverIsExternref)
        ? compileArrayMethodExtern(ctx, fctx, methodAccess, callExpr, "slice")
        : compileArraySlice(ctx, fctx, methodAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType);
      break;
    case "concat":
      // Host methods such as String.prototype.split return ordinary JavaScript
      // arrays. They cannot be cast to the WasmGC vec representation expected
      // by the native concat lowering, so preserve their Array.prototype.concat
      // semantics through the existing host fallback.
      result = receiverIsExternref
        ? ctx.targetProfile.semanticProviders === "native-first" &&
          callExpr.arguments.every(
            (argument) => resolveArrayInfo(ctx, ctx.checker.getTypeAtLocation(argument)) !== null,
          )
          ? compileArrayConcatNativeDynamic(ctx, fctx, methodAccess, callExpr)
          : compileArrayConcatExtern(ctx, fctx, methodAccess, callExpr)
        : compileArrayConcat(ctx, fctx, methodAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType);
      break;
    case "join":
    // #1997: Array.prototype.toString() (§23.1.3.36) is specified to call join
    // with the default "," separator. compileArrayJoin already defaults the
    // separator to "," when no argument is present, and toString receives no
    // arguments, so the two share the same lowering.
    // (#2863 Phase 2) Array/TypedArray.prototype.toLocaleString — standalone/wasi
    // only (host-guarded above); the locale-independent default is the same
    // comma-join. Shares the join lowering.
    case "toLocaleString":
    case "toString":
      // #1286: when the probe found the receiver to be externref at runtime,
      // route through the host-import fallback. The WasmGC-native path expects
      // a vec struct; trying to extract one from a JS array via ref.cast
      // would trap with "illegal cast".
      result = receiverIsExternref
        ? compileArrayJoinExtern(ctx, fctx, methodAccess, callExpr)
        : compileArrayJoin(ctx, fctx, methodAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType);
      break;
    case "splice":
      result = compileArraySplice(ctx, fctx, methodAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType);
      break;
    case "at":
      result = shouldUseHostArrayMethod(ctx, receiverIsExternref)
        ? compileArrayMethodExtern(ctx, fctx, methodAccess, callExpr, "at")
        : compileArrayAt(ctx, fctx, methodAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType);
      break;
    case "fill":
      result = compileArrayFill(ctx, fctx, methodAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType);
      break;
    case "copyWithin":
      result = compileArrayCopyWithin(ctx, fctx, methodAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType);
      break;
    case "lastIndexOf":
      result = compileArrayLastIndexOf(ctx, fctx, methodAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType);
      break;
    case "sort":
      // Host arrays use the ordinary host boundary; Wasm vecs keep native sort.
      result =
        receiverIsExternref && !ctx.standalone && !ctx.wasi
          ? compileArrayMethodExtern(ctx, fctx, methodAccess, callExpr, "sort")
          : elemType.kind === "f64" ||
              elemType.kind === "i32" ||
              elemType.kind === "externref" ||
              elemType.kind === "ref" ||
              elemType.kind === "ref_null"
            ? compileArraySort(ctx, fctx, methodAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType)
            : undefined;
      break;
    // Functional array methods -- numeric (f64, i32) / externref element types,
    // plus ref/ref_null elements when the callback is a provable closure (#3126).
    case "filter":
      result = hofElemKindOk(elemType)
        ? compileArrayFilter(ctx, fctx, methodAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType, receiverIsExternref)
        : undefined;
      break;
    case "map":
      // (#2688) Include ref/ref_null struct-element receivers (mirrors the #1967
      // `sort` gate widening). A `Directive[].map(d => ({…}))` (eslint
      // apply-disable-directives.js) otherwise fell through to a generic builder
      // that typed the result array with the RECEIVER element struct instead of
      // the callback's return struct. `compileArrayMap` derives the result
      // element type from the callback's actual return (typeIdx-aware as of
      // #2688), so routing struct-element receivers through it types the result
      // array correctly.
      result =
        elemType.kind === "f64" ||
        elemType.kind === "i32" ||
        elemType.kind === "externref" ||
        elemType.kind === "ref" ||
        elemType.kind === "ref_null"
          ? compileArrayMap(ctx, fctx, methodAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType, receiverIsExternref)
          : undefined;
      break;
    case "reduce":
      result = hofElemKindOk(elemType)
        ? compileArrayReduce(ctx, fctx, methodAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType, receiverIsExternref)
        : undefined;
      break;
    case "reduceRight":
      result = hofElemKindOk(elemType)
        ? compileArrayReduceRight(
            ctx,
            fctx,
            methodAccess,
            callExpr,
            vecTypeIdx,
            arrTypeIdx,
            elemType,
            receiverIsExternref,
          )
        : undefined;
      break;
    case "forEach": {
      const feResult = hofElemKindOk(elemType)
        ? compileArrayForEach(ctx, fctx, methodAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType, receiverIsExternref)
        : undefined;
      // forEach returns void; use VOID_RESULT so compileExpression doesn't rollback
      result = feResult === null ? (VOID_RESULT as any) : feResult;
      break;
    }
    case "find": {
      const identityLength = canonicalIdentityArrayLength(ctx, methodAccess.expression, callExpr);
      const literal = identityLength === undefined ? undefined : identityFindLiteral(ctx, callExpr, identityLength);
      if (literal) {
        const literalType = compileExpression(ctx, fctx, literal, elemType);
        if (literalType && !valTypesMatch(literalType, elemType)) coerceType(ctx, fctx, literalType, elemType);
        result = elemType;
      } else {
        result = hofElemKindOk(elemType)
          ? compileArrayFind(ctx, fctx, methodAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType, receiverIsExternref)
          : undefined;
      }
      break;
    }
    case "findIndex":
      result = hofElemKindOk(elemType)
        ? compileArrayFindIndex(
            ctx,
            fctx,
            methodAccess,
            callExpr,
            vecTypeIdx,
            arrTypeIdx,
            elemType,
            receiverIsExternref,
          )
        : undefined;
      break;
    case "findLast":
      result = hofElemKindOk(elemType)
        ? compileArrayFindLast(ctx, fctx, methodAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType, receiverIsExternref)
        : undefined;
      break;
    case "findLastIndex":
      result = hofElemKindOk(elemType)
        ? compileArrayFindLastIndex(
            ctx,
            fctx,
            methodAccess,
            callExpr,
            vecTypeIdx,
            arrTypeIdx,
            elemType,
            receiverIsExternref,
          )
        : undefined;
      break;
    case "some":
      result = hofElemKindOk(elemType)
        ? compileArraySome(ctx, fctx, methodAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType, receiverIsExternref)
        : undefined;
      break;
    case "every":
      result = hofElemKindOk(elemType)
        ? compileArrayEvery(ctx, fctx, methodAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType, receiverIsExternref)
        : undefined;
      break;
    case "toReversed":
      result = compileArrayToReversed(ctx, fctx, methodAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType);
      break;
    case "toSorted":
      result =
        elemType.kind === "f64" || elemType.kind === "i32"
          ? compileArrayToSorted(ctx, fctx, methodAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType)
          : undefined;
      break;
    case "toSpliced":
      result = compileArrayToSpliced(ctx, fctx, methodAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType);
      break;
    case "with":
      result = compileArrayWith(ctx, fctx, methodAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType);
      break;
    case "entries":
    case "keys":
    case "values":
      result = compileArrayIteratorMethod(ctx, fctx, methodAccess, methodName);
      break;
    case "flat":
      result = compileArrayFlat(ctx, fctx, methodAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType);
      break;
    case "flatMap":
      result = compileArrayFlatMap(ctx, fctx, methodAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType);
      break;
    case "set": {
      const setResult = compileTypedArraySet(ctx, fctx, methodAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType);
      // TypedArray.prototype.set returns undefined (void).
      result = setResult === null ? null : (VOID_RESULT as any);
      break;
    }
    case "subarray":
      result = compileTypedArraySubarray(ctx, fctx, methodAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType);
      break;
    default:
      result = undefined;
  }

  // Clean up the module-global receiver proxy. Mutating emitters preserve the
  // vec identity and update its backing array in place; writing the temporary
  // reference back is redundant and can be ill-typed when late type
  // registration changed the global's final reference index (#3369).
  if (moduleGlobalIdx !== undefined && savedLocal !== undefined) {
    // Clean up the proxy from localMap
    if (ts.isIdentifier(propAccess.expression)) {
      fctx.localMap.delete(propAccess.expression.text);
    }
  }

  // (#3054 B3) WRITE-THROUGH: a mutating method (`.fill`/`.set`/`.sort`/
  // `.copyWithin`/`.reverse`) ran on the de-viewed native-vec copy — byte-encode
  // the (mutated) copy back into the view's shared buffer so sibling views /
  // DataViews observe it. Gated exactly like the module-global write-back above:
  // only for MUTATING methods that actually ran (result present). Read-only
  // methods skip this (nothing to propagate); B1's de-view stays a pure copy.
  if (
    taViewWbTypeIdx !== undefined &&
    taViewWbViewLocal !== undefined &&
    taViewWbMatLocal !== undefined &&
    taViewWbNativeVecIdx !== undefined &&
    MUTATING.has(methodName) &&
    result !== null &&
    result !== undefined
  ) {
    emitTaViewWriteBack(ctx, fctx, taViewWbTypeIdx, taViewWbViewLocal, taViewWbMatLocal, taViewWbNativeVecIdx);
  }

  // (#3054 B1 Option A) Restore the receiver identifier's original binding after
  // the method dispatched on the materialized native-vec copy. The original var
  // is still the `$__ta_view` (its buffer aliasing is intact for later element
  // access); only this method call saw the de-viewed copy.
  if (taViewRebindName !== undefined) {
    if (taViewRebindSaved !== undefined) fctx.localMap.set(taViewRebindName, taViewRebindSaved);
    else fctx.localMap.delete(taViewRebindName);
  }

  return result;
}

// ── ES2023 non-mutating array methods (toReversed, toSorted, toSpliced, with) ──

/**
 * arr.toReversed() -> returns a new reversed copy of the array.
 * Non-mutating: creates a copy, reverses the copy, returns it.
 */
function compileArrayToReversed(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  _callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
): ValType {
  const vecTmp = allocLocal(fctx, `__arr_trev_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const dataTmp = allocLocal(fctx, `__arr_trev_data_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const newData = allocLocal(fctx, `__arr_trev_nd_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const lenTmp = allocLocal(fctx, `__arr_trev_len_${fctx.locals.length}`, { kind: "i32" });
  const iTmp = allocLocal(fctx, `__arr_trev_i_${fctx.locals.length}`, { kind: "i32" });
  const jTmp = allocLocal(fctx, `__arr_trev_j_${fctx.locals.length}`, { kind: "i32" });

  // Compile receiver -> vec ref
  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.tee", index: vecTmp });
  emitReceiverNullGuard(ctx, fctx, vecTmp);

  // Extract length
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenTmp });

  // Extract data array
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataTmp });

  // newData = array.new_default(len)
  fctx.body.push({ op: "local.get", index: lenTmp });
  fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
  fctx.body.push({ op: "local.set", index: newData });

  // Copy src[0..len] -> newData[0..len]
  emitArrayCopy(fctx, arrTypeIdx, newData, null, dataTmp, null, lenTmp);

  // Now reverse newData in-place: i = 0, j = len - 1
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: iTmp });
  fctx.body.push({ op: "local.get", index: lenTmp });
  fctx.body.push({ op: "i32.const", value: 1 });
  fctx.body.push({ op: "i32.sub" });
  fctx.body.push({ op: "local.set", index: jTmp });

  const swapTmp = allocLocal(fctx, `__arr_trev_sw_${fctx.locals.length}`, elemType);
  const getOp = elemType.kind === "i8" ? "array.get_u" : elemType.kind === "i16" ? "array.get_s" : "array.get";

  const loopBody: Instr[] = [
    { op: "local.get", index: iTmp },
    { op: "local.get", index: jTmp },
    { op: "i32.ge_s" },
    { op: "br_if", depth: 1 },

    // swap = newData[i]
    { op: "local.get", index: newData },
    { op: "local.get", index: iTmp },
    { op: getOp, typeIdx: arrTypeIdx },
    { op: "local.set", index: swapTmp },

    // newData[i] = newData[j]
    { op: "local.get", index: newData },
    { op: "local.get", index: iTmp },
    { op: "local.get", index: newData },
    { op: "local.get", index: jTmp },
    { op: getOp, typeIdx: arrTypeIdx },
    { op: "array.set", typeIdx: arrTypeIdx },

    // newData[j] = swap
    { op: "local.get", index: newData },
    { op: "local.get", index: jTmp },
    { op: "local.get", index: swapTmp },
    { op: "array.set", typeIdx: arrTypeIdx },

    // i++, j--
    { op: "local.get", index: iTmp },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.set", index: iTmp },
    { op: "local.get", index: jTmp },
    { op: "i32.const", value: 1 },
    { op: "i32.sub" },
    { op: "local.set", index: jTmp },
    { op: "br", depth: 0 },
  ];

  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [{ op: "loop", blockType: { kind: "empty" }, body: loopBody }],
  });

  // Return new vec struct: { len, newData }
  fctx.body.push({ op: "local.get", index: lenTmp });
  fctx.body.push({ op: "local.get", index: newData });
  fctx.body.push({ op: "ref.as_non_null" });
  fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
  return { kind: "ref_null", typeIdx: vecTypeIdx };
}

/**
 * arr.toSorted(compareFn?) -> returns a new sorted copy of the array.
 * Non-mutating: creates a copy, sorts the copy in-place via timsort, returns it.
 * Only supports i32/f64 element types (same as sort()).
 */
function compileArrayToSorted(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  _callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
): ValType | null {
  const elemKind = elemType.kind as "i32" | "f64";
  const timsortIdx = ensureTimsortHelper(ctx, vecTypeIdx, arrTypeIdx, elemKind);

  const vecTmp = allocLocal(fctx, `__arr_tsrt_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const dataTmp = allocLocal(fctx, `__arr_tsrt_data_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const newData = allocLocal(fctx, `__arr_tsrt_nd_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const lenTmp = allocLocal(fctx, `__arr_tsrt_len_${fctx.locals.length}`, { kind: "i32" });
  const newVec = allocLocal(fctx, `__arr_tsrt_nv_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });

  // Compile receiver -> vec ref
  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.tee", index: vecTmp });
  emitReceiverNullGuard(ctx, fctx, vecTmp);

  // Extract length
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenTmp });

  // Extract data array
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataTmp });

  // newData = array.new_default(len)
  fctx.body.push({ op: "local.get", index: lenTmp });
  fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
  fctx.body.push({ op: "local.set", index: newData });

  // Copy src[0..len] -> newData[0..len]
  emitArrayCopy(fctx, arrTypeIdx, newData, null, dataTmp, null, lenTmp);

  // Create new vec struct: { len, newData }
  fctx.body.push({ op: "local.get", index: lenTmp });
  fctx.body.push({ op: "local.get", index: newData });
  fctx.body.push({ op: "ref.as_non_null" });
  fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
  fctx.body.push({ op: "local.tee", index: newVec });

  // Sort the new vec in-place via timsort
  fctx.body.push({ op: "call", funcIdx: timsortIdx });

  // Return the new vec
  fctx.body.push({ op: "local.get", index: newVec });
  fctx.body.push({ op: "ref.as_non_null" });
  return { kind: "ref_null", typeIdx: vecTypeIdx };
}

/**
 * arr.toSpliced(start, deleteCount, ...items) -> returns a new array with splice applied.
 * Non-mutating: builds a new array = [arr[0..start], ...items, arr[start+deleteCount..len]].
 */
function compileArrayToSpliced(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
): ValType | null {
  const vecTmp = allocLocal(fctx, `__arr_tspl_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const dataTmp = allocLocal(fctx, `__arr_tspl_data_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const newData = allocLocal(fctx, `__arr_tspl_nd_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const lenTmp = allocLocal(fctx, `__arr_tspl_len_${fctx.locals.length}`, { kind: "i32" });
  const startTmp = allocLocal(fctx, `__arr_tspl_s_${fctx.locals.length}`, { kind: "i32" });
  const delCountTmp = allocLocal(fctx, `__arr_tspl_dc_${fctx.locals.length}`, { kind: "i32" });
  const newLenTmp = allocLocal(fctx, `__arr_tspl_nl_${fctx.locals.length}`, { kind: "i32" });
  const tailStartTmp = allocLocal(fctx, `__arr_tspl_ts_${fctx.locals.length}`, { kind: "i32" });
  const tailCountTmp = allocLocal(fctx, `__arr_tspl_tc_${fctx.locals.length}`, { kind: "i32" });
  const writeTmp = allocLocal(fctx, `__arr_tspl_w_${fctx.locals.length}`, { kind: "i32" });

  const insertCount = Math.max(0, callExpr.arguments.length - 2);

  // Compile receiver -> vec ref
  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.tee", index: vecTmp });
  emitReceiverNullGuard(ctx, fctx, vecTmp);

  // Get length
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenTmp });

  // Get data
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataTmp });

  // start arg -- clamp negative indices
  if (callExpr.arguments.length >= 1) {
    compileExpression(ctx, fctx, callExpr.arguments[0]!, { kind: "f64" });
    fctx.body.push({ op: "i32.trunc_sat_f64_s" });
  } else {
    fctx.body.push({ op: "i32.const", value: 0 });
  }
  fctx.body.push({ op: "local.set", index: startTmp });
  emitClampIndex(fctx, startTmp, lenTmp);

  // deleteCount (default: len - start) -- clamp >= 0 and to remaining len
  if (callExpr.arguments.length >= 2) {
    compileExpression(ctx, fctx, callExpr.arguments[1]!, { kind: "f64" });
    fctx.body.push({ op: "i32.trunc_sat_f64_s" });
  } else {
    fctx.body.push({ op: "local.get", index: lenTmp });
    fctx.body.push({ op: "local.get", index: startTmp });
    fctx.body.push({ op: "i32.sub" });
  }
  fctx.body.push({ op: "local.set", index: delCountTmp });
  emitClampNonNeg(fctx, delCountTmp);
  // Clamp delCount to not exceed remaining elements: min(delCount, len - start)
  fctx.body.push({ op: "local.get", index: lenTmp });
  fctx.body.push({ op: "local.get", index: startTmp });
  fctx.body.push({ op: "i32.sub" });
  fctx.body.push({ op: "local.set", index: tailCountTmp }); // reuse as temp
  fctx.body.push({ op: "local.get", index: delCountTmp });
  fctx.body.push({ op: "local.get", index: tailCountTmp });
  fctx.body.push({ op: "i32.gt_s" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [
      { op: "local.get", index: tailCountTmp },
      { op: "local.set", index: delCountTmp },
    ],
  });
  emitClampNonNeg(fctx, delCountTmp);

  // tailStart = start + delCount
  fctx.body.push({ op: "local.get", index: startTmp });
  fctx.body.push({ op: "local.get", index: delCountTmp });
  fctx.body.push({ op: "i32.add" });
  fctx.body.push({ op: "local.set", index: tailStartTmp });

  // tailCount = len - tailStart
  fctx.body.push({ op: "local.get", index: lenTmp });
  fctx.body.push({ op: "local.get", index: tailStartTmp });
  fctx.body.push({ op: "i32.sub" });
  fctx.body.push({ op: "local.set", index: tailCountTmp });
  emitClampNonNeg(fctx, tailCountTmp);

  // newLen = start + insertCount + tailCount
  fctx.body.push({ op: "local.get", index: startTmp });
  fctx.body.push({ op: "i32.const", value: insertCount });
  fctx.body.push({ op: "i32.add" });
  fctx.body.push({ op: "local.get", index: tailCountTmp });
  fctx.body.push({ op: "i32.add" });
  fctx.body.push({ op: "local.set", index: newLenTmp });

  // newData = array.new_default(newLen)
  fctx.body.push({ op: "local.get", index: newLenTmp });
  fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
  fctx.body.push({ op: "local.set", index: newData });

  // Copy part 1: src[0..start] -> newData[0..start]
  emitArrayCopy(fctx, arrTypeIdx, newData, null, dataTmp, null, startTmp);

  // Part 2: insert items at newData[start..start+insertCount]
  if (insertCount > 0) {
    fctx.body.push({ op: "local.get", index: startTmp });
    fctx.body.push({ op: "local.set", index: writeTmp });
    for (let i = 0; i < insertCount; i++) {
      fctx.body.push({ op: "local.get", index: newData });
      fctx.body.push({ op: "local.get", index: writeTmp });
      compileExpression(ctx, fctx, callExpr.arguments[2 + i]!, elemType);
      fctx.body.push({ op: "array.set", typeIdx: arrTypeIdx });
      if (i < insertCount - 1) {
        fctx.body.push({ op: "local.get", index: writeTmp });
        fctx.body.push({ op: "i32.const", value: 1 });
        fctx.body.push({ op: "i32.add" });
        fctx.body.push({ op: "local.set", index: writeTmp });
      }
    }
  }

  // Part 3: copy tail: src[tailStart..tailStart+tailCount] -> newData[start+insertCount..end]
  // Compute destination offset = start + insertCount
  fctx.body.push({ op: "local.get", index: startTmp });
  fctx.body.push({ op: "i32.const", value: insertCount });
  fctx.body.push({ op: "i32.add" });
  fctx.body.push({ op: "local.set", index: writeTmp });
  emitArrayCopy(fctx, arrTypeIdx, newData, writeTmp, dataTmp, tailStartTmp, tailCountTmp);

  // Return new vec struct: { newLen, newData }
  fctx.body.push({ op: "local.get", index: newLenTmp });
  fctx.body.push({ op: "local.get", index: newData });
  fctx.body.push({ op: "ref.as_non_null" });
  fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
  return { kind: "ref_null", typeIdx: vecTypeIdx };
}

/**
 * arr.with(index, value) -> returns a new array with the element at index replaced.
 * Non-mutating: creates a copy, sets element at index, returns it.
 */
function compileArrayWith(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
): ValType | null {
  if (callExpr.arguments.length < 2) {
    reportError(ctx, callExpr, "with() requires 2 arguments (index, value)");
    return null;
  }

  const vecTmp = allocLocal(fctx, `__arr_with_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const dataTmp = allocLocal(fctx, `__arr_with_data_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const newData = allocLocal(fctx, `__arr_with_nd_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const lenTmp = allocLocal(fctx, `__arr_with_len_${fctx.locals.length}`, { kind: "i32" });
  const idxTmp = allocLocal(fctx, `__arr_with_idx_${fctx.locals.length}`, { kind: "i32" });

  // Compile receiver -> vec ref
  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.tee", index: vecTmp });
  emitReceiverNullGuard(ctx, fctx, vecTmp);

  // Extract length
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenTmp });

  // Extract data array
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataTmp });

  // Compile index arg, handle negative indices
  compileExpression(ctx, fctx, callExpr.arguments[0]!, { kind: "f64" });
  fctx.body.push({ op: "i32.trunc_sat_f64_s" });
  fctx.body.push({ op: "local.set", index: idxTmp });
  emitClampIndex(fctx, idxTmp, lenTmp);

  // newData = array.new_default(len)
  fctx.body.push({ op: "local.get", index: lenTmp });
  fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
  fctx.body.push({ op: "local.set", index: newData });

  // Copy src[0..len] -> newData[0..len]
  emitArrayCopy(fctx, arrTypeIdx, newData, null, dataTmp, null, lenTmp);

  // Set newData[idx] = value
  fctx.body.push({ op: "local.get", index: newData });
  fctx.body.push({ op: "local.get", index: idxTmp });
  compileExpression(ctx, fctx, callExpr.arguments[1]!, elemType);
  fctx.body.push({ op: "array.set", typeIdx: arrTypeIdx });

  // Return new vec struct: { len, newData }
  fctx.body.push({ op: "local.get", index: lenTmp });
  fctx.body.push({ op: "local.get", index: newData });
  fctx.body.push({ op: "ref.as_non_null" });
  fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
  return { kind: "ref_null", typeIdx: vecTypeIdx };
}

/**
 * Compile Array.prototype.entries/keys/values — delegates to host import
 * that creates a proper JS iterator over the WasmGC vec struct.
 */
function compileArrayIteratorMethod(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  methodName: string,
): ValType | null {
  if (ctx.standalone || ctx.wasi) {
    // #1320 Slice 1: native iterator bridge. Build a canonical externref `$Vec`
    // (box each element here, where we have an fctx), wrap it in an `$IterRec`
    // via the native `__iterator`. `.values()` boxes each element, `.keys()`
    // boxes the index, and `.entries()` boxes a 2-element `[i, value]` pair vec
    // per slot — all over the SAME canonical-externref-`$Vec` runtime (no
    // `$GenStateBase` substrate). The consumer destructures each yielded pair
    // externref via the existing array-access path.
    return compileNativeArrayIterator(ctx, fctx, propAccess, methodName);
  }

  addArrayIteratorImports(ctx);
  const importName = `__array_${methodName}`;
  const funcIdx = ctx.funcMap.get(importName);
  if (funcIdx === undefined) return null;

  // Compile receiver and convert to externref for the host import
  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "extern.convert_any" });

  // Call the host import: (externref) → externref
  fctx.body.push({ op: "call", funcIdx });
  return { kind: "externref" };
}

/**
 * #1320 Slice 1 — native standalone/WASI `arr.values()` / `arr.keys()` /
 * `arr.entries()`.
 *
 * Builds a canonical externref `$Vec` from the receiver array (boxing each
 * element here, where we have an `fctx`), then constructs an `$IterRec` over it
 * and returns it as externref — the same value shape the consumer expects from
 * the JS-host `__array_values`/`__array_keys`/`__array_entries` import.
 * `.values()` boxes each element; `.keys()` emits the index as a boxed number;
 * `.entries()` boxes a 2-element `[box(f64(i)), box(value)]` pair vec per slot
 * (itself a canonical externref `$Vec`, `extern.convert_any`-wrapped). The
 * for-of/spread/dstr consumer reads each yielded pair externref via the normal
 * array-access path, so `for (const [k, v] of stored)` lowers `k = pair[0]`,
 * `v = pair[1]`. All three reuse the SAME canonical-externref-`$Vec` runtime —
 * no `$GenStateBase` (native-generator) substrate is touched.
 */
function compileNativeArrayIterator(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  methodName: string,
): ValType | null {
  ensureNativeIteratorRuntime(ctx);
  const iterRecTypeIdx = getOrRegisterIterRecType(ctx);
  const canonVecTypeIdx = getOrRegisterVecType(ctx, "externref", { kind: "externref" });
  const canonArrTypeIdx = getArrTypeIdxFromVec(ctx, canonVecTypeIdx);

  // `.entries()` builds each `[i, value]` slot as an `$ObjVec` so the consumer's
  // indexed read (`pair[0]`/`pair[1]`) routes through the native
  // `__extern_get_idx`/`__extern_length` $ObjVec arm. Register those builders
  // BEFORE compiling the receiver so no function-index shift happens mid-body.
  let objVecNewIdx = 0;
  let objVecPushIdx = 0;
  if (methodName === "entries") {
    const builders = ensureObjVecBuilders(ctx);
    objVecNewIdx = builders.newIdx;
    objVecPushIdx = builders.pushIdx;
  }

  // `Array.prototype` is specified to be an Array exotic object whose initial
  // length is zero. The standalone builtin-value representation is instead a
  // `$NativeProto` metadata carrier, which is deliberately not a `$Vec`; trying
  // to compile it through the generic receiver path therefore rejected Deno's
  // bootstrap-time `%ArrayIteratorPrototype%` capture (#4378). For this exact,
  // unshadowed builtin expression, iterate the spec-equivalent pristine empty
  // array. This intentionally does not claim support for indexed mutations of
  // `Array.prototype`; a user binding named `Array` stays on the normal path.
  const receiver = propAccess.expression;
  const isPristineArrayPrototype = isPristineArrayPrototypeExpression(fctx, receiver);

  // Compile the receiver to discover its vec type. The synthetic receiver uses
  // the canonical externref vec so it can flow through the same iterator
  // runtime as every other empty array without adding a host import.
  let recvType: ValType | null;
  if (isPristineArrayPrototype) {
    fctx.body.push({ op: "i32.const", value: 0 });
    fctx.body.push({ op: "i32.const", value: 0 });
    fctx.body.push({ op: "array.new_default", typeIdx: canonArrTypeIdx });
    fctx.body.push({ op: "struct.new", typeIdx: canonVecTypeIdx });
    recvType = { kind: "ref_null", typeIdx: canonVecTypeIdx };
  } else {
    recvType = compileExpression(ctx, fctx, receiver);
  }
  if (!recvType || (recvType.kind !== "ref" && recvType.kind !== "ref_null")) {
    reportError(ctx, propAccess, `Codegen error: #1320 ${methodName}() receiver is not an array`);
    return null;
  }
  const srcVecTypeIdx = recvType.typeIdx;
  const srcArrTypeIdx = getArrTypeIdxFromVec(ctx, srcVecTypeIdx);
  if (srcArrTypeIdx < 0) {
    reportError(ctx, propAccess, `Codegen error: #1320 ${methodName}() receiver is not a vec`);
    return null;
  }
  const srcArrDef = ctx.mod.types[srcArrTypeIdx];
  const srcElemType: ValType = srcArrDef && srcArrDef.kind === "array" ? srcArrDef.element : { kind: "externref" };

  // locals: srcVec, len, i, out (canonical externref data array)
  const srcVecLocal = allocLocal(fctx, `__iter_src_${fctx.locals.length}`, recvType);
  const lenLocal = allocLocal(fctx, `__iter_len_${fctx.locals.length}`, { kind: "i32" });
  const iLocal = allocLocal(fctx, `__iter_i_${fctx.locals.length}`, { kind: "i32" });
  const outLocal = allocLocal(fctx, `__iter_out_${fctx.locals.length}`, {
    kind: "ref_null",
    typeIdx: canonArrTypeIdx,
  });

  fctx.body.push({ op: "local.set", index: srcVecLocal });
  // len = srcVec.length
  fctx.body.push({ op: "local.get", index: srcVecLocal });
  fctx.body.push({ op: "ref.as_non_null" });
  fctx.body.push({ op: "struct.get", typeIdx: srcVecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenLocal });
  // out = new externref[len]
  fctx.body.push({ op: "local.get", index: lenLocal });
  fctx.body.push({ op: "array.new_default", typeIdx: canonArrTypeIdx });
  fctx.body.push({ op: "local.set", index: outLocal });
  // i = 0
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: iLocal });

  // while (i < len) { out[i] = box(methodName === "keys" ? i : srcVec.data[i]); i++; }
  const loopBody: Instr[] = [];
  // i >= len -> break
  loopBody.push({ op: "local.get", index: iLocal });
  loopBody.push({ op: "local.get", index: lenLocal });
  loopBody.push({ op: "i32.ge_s" });
  loopBody.push({ op: "br_if", depth: 1 });
  // out[i] = ...
  loopBody.push({ op: "local.get", index: outLocal });
  loopBody.push({ op: "ref.as_non_null" });
  loopBody.push({ op: "local.get", index: iLocal });
  // Emit `box(f64(i))` — the numeric index, boxed to externref. Shared by
  // `.keys()` (the slot value) and `.entries()` (the pair's [0] slot).
  const emitBoxedIndex = (): void => {
    fctx.body.push({ op: "local.get", index: iLocal });
    fctx.body.push({ op: "f64.convert_i32_s" });
    coerceType(ctx, fctx, { kind: "f64" }, { kind: "externref" });
  };
  // Emit `box(srcVec.data[i])` — the element, boxed to externref. Shared by
  // `.values()` (the slot value) and `.entries()` (the pair's [1] slot).
  const emitBoxedElem = (): void => {
    fctx.body.push({ op: "local.get", index: srcVecLocal });
    fctx.body.push({ op: "ref.as_non_null" });
    fctx.body.push({ op: "struct.get", typeIdx: srcVecTypeIdx, fieldIdx: 1 });
    fctx.body.push({ op: "local.get", index: iLocal });
    // (#2934) A packed (i8/i16) backing array — a Uint8Array/Int8Array etc.
    // source vec — MUST be read with array.get_u/array.get_s; a plain array.get
    // on a packed array is a hard validator error ("Array type N has packed
    // type i8"). Mirrors the established `getOp` idiom used across this file.
    const getOp = srcElemType.kind === "i8" ? "array.get_u" : srcElemType.kind === "i16" ? "array.get_s" : "array.get";
    fctx.body.push({ op: getOp, typeIdx: srcArrTypeIdx });
    if (srcElemType.kind !== "externref") {
      coerceType(ctx, fctx, srcElemType, { kind: "externref" });
    }
  };

  // Build the element value to box into the canonical externref slot.
  const elemInstrs = collectElemInstrs(ctx, fctx, () => {
    if (methodName === "keys") {
      // value = box(f64(i))   — keys yields the numeric index
      emitBoxedIndex();
    } else if (methodName === "entries") {
      // value = a 2-element `[index, value]` pair built as an `$ObjVec`
      // (key at idx 0, value at idx 1) via __objvec_new + __objvec_push.
      // The `$ObjVec` is the runtime type the native indexed-read helpers
      // (`__extern_get_idx`/`__extern_length`) recognize, so the consumer's
      // `pair[0]`/`pair[1]`/`pair.length` and `[k, v]` destructuring read back
      // correctly — exactly mirroring `__object_entries` (object-runtime.ts).
      // (A canonical `$Vec` pair would NOT read back: `__extern_get` only
      // understands `$Object` shapes, returning undefined for a `$Vec`.)
      const pairLocal = allocLocal(fctx, `__iter_pair_${fctx.locals.length}`, { kind: "externref" });
      fctx.body.push({ op: "call", funcIdx: objVecNewIdx });
      fctx.body.push({ op: "local.tee", index: pairLocal });
      emitBoxedIndex();
      fctx.body.push({ op: "call", funcIdx: objVecPushIdx });
      fctx.body.push({ op: "local.get", index: pairLocal });
      emitBoxedElem();
      fctx.body.push({ op: "call", funcIdx: objVecPushIdx });
      // The pair externref itself goes into the outer canonical slot.
      fctx.body.push({ op: "local.get", index: pairLocal });
    } else {
      // value = box(srcVec.data[i])  — values yields the element
      emitBoxedElem();
    }
  });
  loopBody.push(...elemInstrs);
  loopBody.push({ op: "array.set", typeIdx: canonArrTypeIdx });
  // i++
  loopBody.push({ op: "local.get", index: iLocal });
  loopBody.push({ op: "i32.const", value: 1 });
  loopBody.push({ op: "i32.add" });
  loopBody.push({ op: "local.set", index: iLocal });
  loopBody.push({ op: "br", depth: 0 });

  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [{ op: "loop", blockType: { kind: "empty" }, body: loopBody }],
  });

  // Result = the canonical externref `$Vec`, wrapped to externref. Per the
  // #1320 Slice-1 producer/consumer contract (Option 1): the producer hands
  // back the canonical vec and the *consumer* (`__iterator`, called from the
  // for-of driver) wraps it into the `$IterRec`. So `arr.values()`/`.keys()`
  // as a value is a canonical externref vec; the for-of consumer does
  // `__iterator(vec)` → IterRec → `__iterator_next`. Single wrap point.
  fctx.body.push({ op: "local.get", index: lenLocal });
  fctx.body.push({ op: "local.get", index: outLocal });
  fctx.body.push({ op: "ref.as_non_null" });
  fctx.body.push({ op: "struct.new", typeIdx: canonVecTypeIdx });
  fctx.body.push({ op: "extern.convert_any" });
  void iterRecTypeIdx; // type registered eagerly via ensureNativeIteratorRuntime
  return { kind: "externref" };
}

/** Capture instrs emitted by `emit` into a fresh array (mirrors collectInstrs). */
function collectElemInstrs(_ctx: CodegenContext, fctx: FunctionContext, emit: () => void): Instr[] {
  const before = fctx.body.length;
  emit();
  return fctx.body.splice(before);
}

/** Helper: emit array.copy instruction.
 * Stack: [dstArr, dstOffset, srcArr, srcOffset, count] -> []
 * All args are local indices.
 */
function emitArrayCopy(
  fctx: FunctionContext,
  arrTypeIdx: number,
  dstArr: number,
  dstOffset: number | null, // local index, or null for 0
  srcArr: number,
  srcOffset: number | null, // local index, or null for 0
  count: number, // local index holding count
): void {
  fctx.body.push({ op: "local.get", index: dstArr });
  if (dstOffset !== null) {
    fctx.body.push({ op: "local.get", index: dstOffset });
  } else {
    fctx.body.push({ op: "i32.const", value: 0 });
  }
  fctx.body.push({ op: "local.get", index: srcArr });
  if (srcOffset !== null) {
    fctx.body.push({ op: "local.get", index: srcOffset });
  } else {
    fctx.body.push({ op: "i32.const", value: 0 });
  }
  fctx.body.push({ op: "local.get", index: count });
  fctx.body.push({ op: "array.copy", dstTypeIdx: arrTypeIdx, srcTypeIdx: arrTypeIdx });
}

/**
 * arr.at(index) -> supports negative indexing.
 * If index < 0, actual = length + index; otherwise actual = index.
 * Returns elem at computed index.
 */
function compileArrayAt(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
): ValType | null {
  const vecTmp = allocLocal(fctx, `__arr_at_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const idxTmp = allocLocal(fctx, `__arr_at_idx_${fctx.locals.length}`, { kind: "i32" });
  const lenTmp = allocLocal(fctx, `__arr_at_len_${fctx.locals.length}`, { kind: "i32" });

  // Compile receiver
  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.set", index: vecTmp });
  emitReceiverNullGuard(ctx, fctx, vecTmp);

  // Get length
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenTmp });

  // Compile index argument. §23.1.3.1 Array.prototype.at step 2:
  // relativeIndex = ToIntegerOrInfinity(index) = truncate-toward-zero of
  // ToNumber(index) (§7.1.5), NOT a direct i32 coercion. In standalone a fast
  // i32 coercion of a non-integer-typed index (a numeric *string* like `"1"`,
  // a `{valueOf(){…}}` object) resolves to the wrong slot — `a.at("1")` landed
  // on index 0 instead of 1 (#2644, the Array analog of the String-method fix
  // #2600). Route the arg through the existing numeric coercion engine to f64
  // (string → `__str_to_number`, object → ToPrimitive("number") — both already
  // present for `+x` / `Number(x)`), then apply ToIntegerOrInfinity: NaN → 0,
  // else `i32.trunc_sat_f64_s` (truncates toward zero; ±∞ saturates and the
  // following <0 wrap + bounds check clamp it). No new #2108 coercion site —
  // `coerceType` reuse only. The legacy direct-i32 path is kept for the JS-host
  // mode (which coerces strings via a host import).
  // (#5095) `index` is an ORDINARY parameter, so `arr.at()` is legal JS and is
  // exactly `arr.at(0)` — ToIntegerOrInfinity(undefined) is +0. Rejecting it (an
  // `at() requires 1 argument` reportError here) collapsed the whole call into the
  // caller's degraded fallback, so `[10,20,30].at()` answered the INDEX `0`, not
  // `10` (`undefined` in value position — one collapse, two coercion paths). Same
  // shape as `includes`'s absent searchElement (`emitIncludesSearchValue`, #2872);
  // covers the TypedArray receiver too, which shares this lowering.
  if (callExpr.arguments.length < 1) {
    fctx.body.push({ op: "i32.const", value: 0 });
  } else if (noJsHost(ctx)) {
    const argType = compileExpression(ctx, fctx, callExpr.arguments[0]!);
    if (!argType) {
      // void → undefined → ToNumber NaN → ToIntegerOrInfinity 0.
      fctx.body.push({ op: "i32.const", value: 0 });
    } else if (argType.kind === "i32") {
      // Already an integer (boolean / int-typed index) — in range, no ToNumber.
    } else if (argType.kind === "i64") {
      // BigInt index → TypeError per ToNumber (§7.1.4).
      fctx.body.push({ op: "drop" });
      emitThrowTypeError(ctx, fctx, "Cannot convert a BigInt value to a number");
      fctx.body.push({ op: "i32.const", value: 0 });
    } else {
      // Coerce ToNumber → f64 via the engine, then ToIntegerOrInfinity.
      coerceType(ctx, fctx, argType, { kind: "f64" }, "number");
      const fTmp = allocLocal(fctx, `__arr_at_f_${fctx.locals.length}`, { kind: "f64" });
      fctx.body.push({ op: "local.set", index: fTmp });
      fctx.body.push({ op: "local.get", index: fTmp });
      fctx.body.push({ op: "local.get", index: fTmp });
      fctx.body.push({ op: "f64.ne" }); // self != self ⇒ NaN
      fctx.body.push({
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: [{ op: "i32.const", value: 0 }],
        else: [{ op: "local.get", index: fTmp }, { op: "i32.trunc_sat_f64_s" }],
      });
    }
  } else {
    const argType = compileExpression(ctx, fctx, callExpr.arguments[0]!, { kind: "i32" });
    if (argType && argType.kind === "f64") {
      fctx.body.push({ op: "i32.trunc_sat_f64_s" });
    }
  }
  fctx.body.push({ op: "local.set", index: idxTmp });

  // If index < 0, add length to it
  fctx.body.push({ op: "local.get", index: idxTmp });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "i32.lt_s" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [
      { op: "local.get", index: idxTmp },
      { op: "local.get", index: lenTmp },
      { op: "i32.add" },
      { op: "local.set", index: idxTmp },
    ],
  });

  // Access element: data[idx] with bounds check. (#2001 S1) Pass `ctx` so an
  // in-bounds `$Hole` slot maps to `undefined` (at() of a hole is undefined).
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.get", index: idxTmp });
  emitBoundsCheckedArrayGet(fctx, arrTypeIdx, elemType, ctx);

  return elemType;
}

/**
 * arr.indexOf(val) -> loop through array, return index (as f64) or -1.
 * Receiver is a vec struct; extract data and length from it.
 */
function compileArrayIndexOf(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
): ValType | null {
  const vecTmp = allocLocal(fctx, `__arr_iof_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const dataTmp = allocLocal(fctx, `__arr_iof_data_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const iTmp = allocLocal(fctx, `__arr_iof_i_${fctx.locals.length}`, { kind: "i32" });
  const lenTmp = allocLocal(fctx, `__arr_iof_len_${fctx.locals.length}`, { kind: "i32" });
  // Packed i8/i16 elements load (and compare) as i32 — never store the raw
  // packed type in a local (#2648).
  const valType = unpackedElemType(elemType);
  const valTmp = allocLocal(fctx, `__arr_iof_val_${fctx.locals.length}`, valType);

  // Compile receiver -> vec ref
  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.tee", index: vecTmp });
  emitReceiverNullGuard(ctx, fctx, vecTmp);

  // Extract length from vec struct field 0
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenTmp });

  // Extract data array from vec struct field 1
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataTmp });

  // (#3201) A sparse array (logical `.length` set beyond the physical backing,
  // or a high-index write) has `lenTmp` (field 0) > `array.len(dataTmp)`. The
  // search loop below reads `data[i]` with a raw `array.get`, which TRAPS
  // ("array element access out of bounds") once `i` passes the backing length.
  // Per §23.1.3.14 (HasProperty-driven) those absent indices are SKIPPED, so
  // clamp the iteration bound to the backing length — the beyond-backing holes
  // can never strict-equal the search value anyway. Normal (non-sparse) vecs
  // keep `lenTmp` unchanged (backing capacity ≥ length ⇒ min is the length).
  const effLenTmp = allocLocal(fctx, `__arr_iof_efflen_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "local.get", index: lenTmp });
  fctx.body.push({ op: "local.get", index: dataTmp });
  fctx.body.push({ op: "array.len" });
  fctx.body.push({ op: "i32.lt_s" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "i32" } },
    then: [{ op: "local.get", index: lenTmp }],
    else: [{ op: "local.get", index: dataTmp }, { op: "array.len" }],
  });
  fctx.body.push({ op: "local.set", index: effLenTmp });

  // (#5121 S1) `searchElement` is an ORDINARY parameter, so `a.indexOf()` is
  // legal JS and searches for `undefined` (§23.1.3.13 step 1). Rejecting it (an
  // `indexOf requires 1 argument` reportError here) returned null, whose
  // diagnostic the caller SWALLOWS — `compile()` reports `success: true` with an
  // EMPTY errors array — so the call collapsed into the caller's degraded
  // fallback and `[10,20,30].indexOf()` answered `0` instead of `-1`. Identical
  // mechanism to #5095 (`at()`), one method over; the difference is that the
  // default is a search VALUE compared with STRICT equality, not an index.
  const searchArg = callExpr.arguments[0];
  if (searchArg !== undefined) {
    compileExpression(ctx, fctx, searchArg, elemType);
    fctx.body.push({ op: "local.set", index: valTmp });
  } else if (emitIndexOfAbsentSearchValue(ctx, fctx, valType, valTmp)) {
    // No value of this element type can strictly-equal `undefined` ⇒ -1 with no
    // scan. A zero-argument call has no `fromIndex`, so nothing is left to
    // evaluate for side effects (the receiver is already in `vecTmp`).
    fctx.body.push(ctx.fast ? { op: "i32.const", value: -1 } : { op: "f64.const", value: -1 });
    return ctx.fast ? { kind: "i32" } : { kind: "f64" };
  }

  // fromIndex (optional 2nd arg, default 0)
  if (callExpr.arguments.length >= 2) {
    // (#3201) §23.1.3.14 step 3: if len is 0, return -1 BEFORE step 4's
    // ToIntegerOrInfinity(fromIndex) — a throwing `valueOf` on the fromIndex
    // object must NOT be observed on an empty array
    // (indexOf/length-zero-returns-minus-one.js). Compile the coercion into
    // the main body, then splice it into a `len != 0` guard arm — spliced
    // instrs are immediately re-embedded in fctx.body (nested arms ARE
    // walked by flushLateImportShifts' recursive shiftBody), so no detached-
    // array funcIdx staleness. The len==0 arm leaves iTmp at 0; the loop
    // bound (effLenTmp == 0) then falls through to the -1 result.
    const guardStart = fctx.body.length;
    if (ctx.fast) {
      compileExpression(ctx, fctx, callExpr.arguments[1]!, { kind: "i32" });
    } else {
      compileExpression(ctx, fctx, callExpr.arguments[1]!, { kind: "f64" });
      fctx.body.push({ op: "i32.trunc_sat_f64_s" });
    }
    // Clamp negative fromIndex: if (fromIndex < 0) fromIndex = max(0, length + fromIndex)
    const fromTmp = allocLocal(fctx, `__arr_iof_from_${fctx.locals.length}`, { kind: "i32" });
    fctx.body.push({ op: "local.tee", index: fromTmp });
    fctx.body.push({ op: "i32.const", value: 0 });
    fctx.body.push({ op: "i32.lt_s" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: lenTmp },
        { op: "local.get", index: fromTmp },
        { op: "i32.add" },
        { op: "local.tee", index: fromTmp },
        { op: "i32.const", value: 0 },
        { op: "i32.lt_s" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "i32.const", value: 0 },
            { op: "local.set", index: fromTmp },
          ],
        },
      ],
    });
    fctx.body.push({ op: "local.get", index: fromTmp });
    fctx.body.push({ op: "local.set", index: iTmp });
    const guarded = fctx.body.splice(guardStart);
    fctx.body.push({ op: "local.get", index: lenTmp });
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: guarded,
      else: [
        { op: "i32.const", value: 0 },
        { op: "local.set", index: iTmp },
      ],
    });
  } else {
    fctx.body.push({ op: "i32.const", value: 0 });
    fctx.body.push({ op: "local.set", index: iTmp });
  }

  // (#2648) Drive the packed i8/i16 load off the VIEW NAME signedness so a
  // signed Int8/Int16 value (`Int8Array([-1]).indexOf(-1)`) and an unsigned
  // high Uint16 value (`Uint16Array([40000]).indexOf(40000)`) both match.
  const getOp = elemGetOp(elemType, typedArraySearchSignedness(ctx, propAccess.expression));

  // For externref elements, use __host_eq (JS Strict Equality, §7.2.16) so
  // object identity, cross-type (e.g. `[false].indexOf(0)`), and string
  // comparisons all follow spec. The wasm:js-string `equals` builtin coerces
  // both operands to strings, which mis-matches object/boolean/number
  // elements (#786 — `indexOf` on an externref vec).
  // For ref/ref_null elements, use ref.eq for reference identity comparison.
  let eqInstrs: Instr[];
  if (elemType.kind === "externref") {
    // (#2719) Standalone/WASI have no JS host, so the `__host_eq` import is
    // unsatisfiable and the module fails to instantiate. Route element Strict
    // Equality through the pure-Wasm `__extern_strict_eq` helper there (composed
    // from `__any_from_extern` + `__any_strict_eq`, §7.2.16-equivalent). Host/gc
    // mode keeps the `__host_eq` host import. Mirrors the standalone arm in
    // `compileArrayLikePrototypeSearch` (the `.call(...)` form).
    const nativeCmp = ctx.standalone || ctx.wasi;
    const cmpIdx = nativeCmp
      ? ensureExternStrictEqHelper(ctx)
      : ensureLateImport(ctx, "__host_eq", [{ kind: "externref" }, { kind: "externref" }], [{ kind: "i32" }]);
    flushLateImportShifts(ctx, fctx);
    const cmpName = nativeCmp ? "__extern_strict_eq" : "__host_eq";
    const finalCmpIdx = ctx.funcMap.get(cmpName) ?? cmpIdx;
    if (finalCmpIdx === undefined) {
      reportError(ctx, callExpr, "indexOf: failed to bind element equality helper");
      return null;
    }
    eqInstrs = [{ op: "call", funcIdx: finalCmpIdx }];
  } else if (elemType.kind === "ref" || elemType.kind === "ref_null") {
    // #2036 — native-string elements compare by content (§7.2.16), not identity.
    eqInstrs = nativeStringElementEqInstrs(ctx, fctx, elemType) ?? [{ op: "ref.eq" }];
  } else {
    const eqOp = elemType.kind === "f64" ? "f64.eq" : "i32.eq";
    eqInstrs = [{ op: eqOp }];
  }

  // Use a result local instead of `return` to avoid returning from the
  // enclosing function when indexOf is inlined.
  const resType: ValType = ctx.fast ? { kind: "i32" } : { kind: "f64" };
  const resTmp = allocLocal(fctx, `__arr_iof_res_${fctx.locals.length}`, resType);
  if (ctx.fast) {
    fctx.body.push({ op: "i32.const", value: -1 });
  } else {
    fctx.body.push({ op: "f64.const", value: -1 });
  }
  fctx.body.push({ op: "local.set", index: resTmp });

  // (#2001 S1 — indexOf hole-SKIP DEFERRED, see the S2 boundary note.) §23.1.3.14
  // uses HasProperty, so a clean sparse hole should be SKIPPED
  // (`[1,,3].indexOf(undefined) === -1`). But test262's only sparse-hole indexOf
  // tests combine a hole with a prototype-INHERITED index
  // (`Object.defineProperty(Array.prototype,"0",…)`), which the flat WasmGC vec
  // cannot model — those pass coincidentally via this S1 `$Hole → undefined` map,
  // and a spec-correct skip regresses them for no offsetting test262 win. Keep S1
  // here (net-0) until prototype-index inheritance is modeled. Pre-ensure
  // `__get_undefined` so the detached `holeToUndefinedInstrs` flush can't shift
  // the captured `__host_eq` funcIdx.
  let holeMap: Instr[] = [];
  if (ctx.usesArrayHoles && elemType.kind === "externref") {
    ensureGetUndefined(ctx);
    flushLateImportShifts(ctx, fctx);
    holeMap = holeToUndefinedInstrs(ctx, fctx);
  }

  emitArrayIndexOfScan(fctx, {
    fast: ctx.fast,
    arrTypeIdx,
    dataLocal: dataTmp,
    indexLocal: iTmp,
    effectiveLengthLocal: effLenTmp,
    valueLocal: valTmp,
    resultLocal: resTmp,
    getOp,
    equality: eqInstrs,
    holeMap,
    unroll: countedPushIndexOfUnroll(
      fctx,
      ts.isIdentifier(propAccess.expression) ? propAccess.expression.text : undefined,
      elemType,
    ),
  });
  fctx.body.push({ op: "local.get", index: resTmp });
  return ctx.fast ? { kind: "i32" } : { kind: "f64" };
}

/**
 * arr.includes(val) -> like indexOf but returns i32 (0 or 1)
 * Receiver is a vec struct.
 */
function compileArrayIncludes(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
): ValType | null {
  const vecTmp = allocLocal(fctx, `__arr_inc_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const dataTmp = allocLocal(fctx, `__arr_inc_data_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const iTmp = allocLocal(fctx, `__arr_inc_i_${fctx.locals.length}`, { kind: "i32" });
  const lenTmp = allocLocal(fctx, `__arr_inc_len_${fctx.locals.length}`, { kind: "i32" });
  // Packed i8/i16 elements load (and compare) as i32 — never store the raw
  // packed type in a local (#2648).
  const valType = unpackedElemType(elemType);
  const valTmp = allocLocal(fctx, `__arr_inc_val_${fctx.locals.length}`, valType);

  // Compile receiver -> vec ref
  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.tee", index: vecTmp });
  emitReceiverNullGuard(ctx, fctx, vecTmp);

  // Extract length
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenTmp });

  // Extract data
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataTmp });

  // (#3201) A sparse array (logical `.length` set beyond the physical WasmGC
  // backing) has `lenTmp` (field 0) > `array.len(dataTmp)`. The scan loop below
  // reads `data[i]` with a raw `array.get`, which TRAPS ("array element access
  // out of bounds") once `i` passes the backing length. Per §23.1.3.16 those
  // beyond-backing indices are absent holes read (via Get, not HasProperty) as
  // `undefined` — so clamp the PHYSICAL scan to the backing length (bounded,
  // never iterating a possibly-huge logical `.length`); the beyond-backing
  // `undefined` holes are handled by the O(1) post-loop check below. Dense
  // (non-sparse) vecs keep `effLen == lenTmp` (backing capacity ≥ length ⇒ min
  // is the length), so the clamp is a runtime no-op there.
  const effLenTmp = allocLocal(fctx, `__arr_inc_efflen_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "local.get", index: lenTmp });
  fctx.body.push({ op: "local.get", index: dataTmp });
  fctx.body.push({ op: "array.len" });
  fctx.body.push({ op: "i32.lt_s" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "i32" } },
    then: [{ op: "local.get", index: lenTmp }],
    else: [{ op: "local.get", index: dataTmp }, { op: "array.len" }],
  });
  fctx.body.push({ op: "local.set", index: effLenTmp });

  const incNeverMatches = emitIncludesSearchValue(ctx, fctx, callExpr, valType, valTmp);

  // fromIndex (optional 2nd arg, default 0)
  if (callExpr.arguments.length >= 2) {
    if (ctx.fast) {
      compileExpression(ctx, fctx, callExpr.arguments[1]!, { kind: "i32" });
    } else {
      compileExpression(ctx, fctx, callExpr.arguments[1]!, { kind: "f64" });
      fctx.body.push({ op: "i32.trunc_sat_f64_s" });
    }
    // Clamp negative fromIndex: if (fromIndex < 0) fromIndex = max(0, length + fromIndex)
    const fromTmp = allocLocal(fctx, `__arr_inc_from_${fctx.locals.length}`, { kind: "i32" });
    fctx.body.push({ op: "local.tee", index: fromTmp });
    fctx.body.push({ op: "i32.const", value: 0 });
    fctx.body.push({ op: "i32.lt_s" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: lenTmp },
        { op: "local.get", index: fromTmp },
        { op: "i32.add" },
        { op: "local.tee", index: fromTmp },
        { op: "i32.const", value: 0 },
        { op: "i32.lt_s" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "i32.const", value: 0 },
            { op: "local.set", index: fromTmp },
          ],
        },
      ],
    });
    fctx.body.push({ op: "local.get", index: fromTmp });
  } else {
    fctx.body.push({ op: "i32.const", value: 0 });
  }
  fctx.body.push({ op: "local.set", index: iTmp });

  // (#2648) View-name-driven signedness for the packed i8/i16 element load.
  const getOp = elemGetOp(elemType, typedArraySearchSignedness(ctx, propAccess.expression));

  // SameValueZero comparison for includes:
  // - For f64: a === b OR (isNaN(a) AND isNaN(b))
  // - For externref: use JS === via equals import
  // - For ref/ref_null: ref.eq
  // - For i32: i32.eq
  //
  // We build a comparison that leaves i32 (0/1) on the stack.
  // For f64, we need a temp local to hold the element for the NaN check.
  let incNeedsElemTmp = false;
  let incElemTmp: number | undefined;
  if (elemType.kind === "f64") {
    incNeedsElemTmp = true;
    incElemTmp = allocLocal(fctx, `__arr_inc_el_${fctx.locals.length}`, { kind: "f64" });
  }

  // Use a result local instead of `return` to avoid type mismatch with enclosing function
  const resTmp = allocLocal(fctx, `__arr_inc_res_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: resTmp });

  // Build the comparison instructions for the loop body
  let comparisonInstrs: Instr[];
  if (elemType.kind === "f64") {
    // SameValueZero for f64: (elem == val) | (isNaN(elem) & isNaN(val))
    comparisonInstrs = [
      // Load element and save to temp
      { op: "local.get", index: dataTmp },
      { op: "local.get", index: iTmp },
      { op: getOp, typeIdx: arrTypeIdx },
      { op: "local.tee", index: incElemTmp! },
      // elem == val
      { op: "local.get", index: valTmp },
      { op: "f64.eq" },
      // isNaN(elem) = elem != elem
      { op: "local.get", index: incElemTmp! },
      { op: "local.get", index: incElemTmp! },
      { op: "f64.ne" },
      // isNaN(val) = val != val
      { op: "local.get", index: valTmp },
      { op: "local.get", index: valTmp },
      { op: "f64.ne" },
      // isNaN(elem) & isNaN(val)
      { op: "i32.and" },
      // (elem == val) | (both NaN)
      { op: "i32.or" },
    ];
  } else if (elemType.kind === "externref") {
    // SameValueZero (§7.2.11) via __same_value_zero: NaN matches NaN, object
    // identity, cross-type → false. The wasm:js-string `equals` builtin
    // coerces both operands to strings, mis-matching object/boolean/number
    // elements (#786 — `includes` on an externref vec).
    // (#2719) Standalone/WASI have no JS host, so the `__same_value_zero` import
    // is unsatisfiable. Route SameValueZero through the pure-Wasm
    // `__extern_same_value_zero` helper there; host/gc mode keeps the import.
    const nativeCmp = ctx.standalone || ctx.wasi;
    const svzIdx = nativeCmp
      ? ensureExternSameValueZeroHelper(ctx)
      : ensureLateImport(ctx, "__same_value_zero", [{ kind: "externref" }, { kind: "externref" }], [{ kind: "i32" }]);
    flushLateImportShifts(ctx, fctx);
    const svzName = nativeCmp ? "__extern_same_value_zero" : "__same_value_zero";
    const finalSvzIdx = ctx.funcMap.get(svzName) ?? svzIdx;
    if (finalSvzIdx === undefined) {
      reportError(ctx, callExpr, "includes: failed to bind SameValueZero helper");
      return null;
    }
    // (#2001 S1) §22.1.3.13 includes uses Get (holes → undefined), so
    // `[,].includes(undefined) === true`. Map the `$Hole` slot to undefined
    // before SameValueZero. Pre-ensure `__get_undefined` so the detached
    // mapping's flush can't shift the captured `__same_value_zero` funcIdx.
    let incHoleMap: Instr[] = [];
    if (ctx.usesArrayHoles) {
      ensureGetUndefined(ctx);
      flushLateImportShifts(ctx, fctx);
      incHoleMap = holeToUndefinedInstrs(ctx, fctx);
    }
    comparisonInstrs = [
      { op: "local.get", index: dataTmp },
      { op: "local.get", index: iTmp },
      { op: getOp, typeIdx: arrTypeIdx },
      ...incHoleMap,
      { op: "local.get", index: valTmp },
      { op: "call", funcIdx: finalSvzIdx },
    ];
  } else if (elemType.kind === "ref" || elemType.kind === "ref_null") {
    // #2036 — native-string elements use SameValueZero by content (which equals
    // strict equality for strings — no NaN/±0 subtlety), not reference identity.
    const strEq = nativeStringElementEqInstrs(ctx, fctx, elemType);
    comparisonInstrs = [
      { op: "local.get", index: dataTmp },
      { op: "local.get", index: iTmp },
      { op: getOp, typeIdx: arrTypeIdx },
      { op: "local.get", index: valTmp },
      ...(strEq ?? [{ op: "ref.eq" }]),
    ];
  } else {
    const eqOp = "i32.eq";
    comparisonInstrs = [
      { op: "local.get", index: dataTmp },
      { op: "local.get", index: iTmp },
      { op: getOp, typeIdx: arrTypeIdx },
      { op: "local.get", index: valTmp },
      { op: eqOp },
    ];
  }

  if (incNeverMatches) comparisonInstrs = [{ op: "i32.const", value: 0 }];

  const loopBody: Instr[] = [
    { op: "local.get", index: iTmp },
    { op: "local.get", index: effLenTmp }, // (#3201) clamp physical scan to backing
    { op: "i32.ge_s" },
    { op: "br_if", depth: 1 },

    ...comparisonInstrs,
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
 * arr.reverse() -> swap elements in place on the data array, return same vec ref.
 */
function compileArrayReverse(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  _callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
): ValType {
  const vecTmp = allocLocal(fctx, `__arr_rev_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const dataTmp = allocLocal(fctx, `__arr_rev_data_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const iTmp = allocLocal(fctx, `__arr_rev_i_${fctx.locals.length}`, { kind: "i32" });
  const jTmp = allocLocal(fctx, `__arr_rev_j_${fctx.locals.length}`, { kind: "i32" });
  const swapTmp = allocLocal(fctx, `__arr_rev_sw_${fctx.locals.length}`, elemType);

  // Compile receiver -> vec ref
  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.tee", index: vecTmp });
  emitReceiverNullGuard(ctx, fctx, vecTmp);

  // Extract length from vec, then j = length - 1
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "i32.const", value: 1 });
  fctx.body.push({ op: "i32.sub" });
  fctx.body.push({ op: "local.set", index: jTmp });

  // Extract data array
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataTmp });

  // (#3201 write-path) A SPARSE array (logical `.length` beyond the WasmGC
  // backing via `a.length = N`) makes the two-pointer swap read/write `data[i]`
  // / `data[j]` up to the LOGICAL length (`j = length - 1`) and TRAP ("array
  // element access out of bounds"). Grow the backing to the logical length
  // (`j + 1`) so the whole reversal lands in-bounds. Standalone/WASI-gated
  // (host/gc byte-identical); dense receiver ⇒ runtime no-op.
  if (ctx.standalone || ctx.wasi) {
    const needTmp = allocLocal(fctx, `__arr_rev_need_${fctx.locals.length}`, { kind: "i32" });
    fctx.body.push({ op: "local.get", index: jTmp });
    fctx.body.push({ op: "i32.const", value: 1 });
    fctx.body.push({ op: "i32.add" });
    fctx.body.push({ op: "local.set", index: needTmp });
    emitEnsureBackingCapacity(fctx, vecTmp, dataTmp, vecTypeIdx, arrTypeIdx, needTmp);
  }

  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: iTmp });

  const getOp = elemType.kind === "i8" ? "array.get_u" : elemType.kind === "i16" ? "array.get_s" : "array.get";

  const loopBody: Instr[] = [
    { op: "local.get", index: iTmp },
    { op: "local.get", index: jTmp },
    { op: "i32.ge_s" },
    { op: "br_if", depth: 1 },

    // swap = data[i]
    { op: "local.get", index: dataTmp },
    { op: "local.get", index: iTmp },
    { op: getOp, typeIdx: arrTypeIdx },
    { op: "local.set", index: swapTmp },

    // data[i] = data[j]
    { op: "local.get", index: dataTmp },
    { op: "local.get", index: iTmp },
    { op: "local.get", index: dataTmp },
    { op: "local.get", index: jTmp },
    { op: getOp, typeIdx: arrTypeIdx },
    { op: "array.set", typeIdx: arrTypeIdx },

    // data[j] = swap
    { op: "local.get", index: dataTmp },
    { op: "local.get", index: jTmp },
    { op: "local.get", index: swapTmp },
    { op: "array.set", typeIdx: arrTypeIdx },

    // i++, j--
    { op: "local.get", index: iTmp },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.set", index: iTmp },

    { op: "local.get", index: jTmp },
    { op: "i32.const", value: 1 },
    { op: "i32.sub" },
    { op: "local.set", index: jTmp },

    { op: "br", depth: 0 },
  ];

  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [{ op: "loop", blockType: { kind: "empty" }, body: loopBody }],
  });

  // Return same vec ref
  fctx.body.push({ op: "local.get", index: vecTmp });
  return { kind: "ref_null", typeIdx: vecTypeIdx };
}

/**
 * arr.push(val, ...) -> capacity-based amortized push supporting multiple arguments.
 * Mutates vec struct in-place: grows backing array if needed, sets elements, increments length.
 */
/**
 * (#4531) Guarded dual-lane `push`/`pop` for an EXTERNREF-shaped receiver —
 * the class-field case where the slot may hold either the native vec (boxed
 * through externref) or its `__make_iterable` host MIRROR (prettier's
 * `this.stack`). `ref.test` the registered vec carriers: on hit call the
 * unconditionally-exported native `__vec_push`/`__vec_pop` helper; else route
 * through the host `__extern_method_call` bridge, whose `_tryWasmVecMutation`
 * resolves a registered mirror back to its source vec (runtime.ts). Mirrors
 * the #2784 S3 arm in call-receiver-method.ts. Returns undefined when a
 * required import could not be ensured (caller falls back to the native path).
 */
function compileExternReceiverPushPop(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  callExpr: ts.CallExpression,
  methodName: "push" | "pop",
): ValType | undefined {
  if (!ts.isPropertyAccessExpression(propAccess)) return undefined;
  const mcIdx = ensureLateImport(
    ctx,
    "__extern_method_call",
    [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
    [{ kind: "externref" }],
  );
  const arrNewIdx = ensureLateImport(ctx, "__js_array_new", [], [{ kind: "externref" }]);
  const arrPushIdx = ensureLateImport(ctx, "__js_array_push", [{ kind: "externref" }, { kind: "externref" }], []);
  const boxNumIdx =
    methodName === "push"
      ? ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }])
      : undefined;
  addStringConstantGlobal(ctx, methodName);
  flushLateImportShifts(ctx, fctx);
  const vecOpIdx = reserveVecMethodHelper(ctx, methodName);
  if (
    vecOpIdx === undefined ||
    mcIdx === undefined ||
    arrNewIdx === undefined ||
    arrPushIdx === undefined ||
    (methodName === "push" && boxNumIdx === undefined)
  ) {
    return undefined;
  }
  // Receiver -> externref local.
  const recvT = compileExpression(ctx, fctx, propAccess.expression, { kind: "externref" });
  if (recvT && recvT.kind !== "externref") coerceType(ctx, fctx, recvT, { kind: "externref" });
  else if (!recvT) fctx.body.push({ op: "ref.null.extern" });
  const recvLocal = allocLocal(fctx, `__xr_pp_recv_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: recvLocal });
  // push's element -> argLocal (side effects evaluated once, up front).
  let argLocal: number | undefined;
  if (methodName === "push") {
    const a = callExpr.arguments[0];
    if (a) {
      const at = compileExpression(ctx, fctx, a, { kind: "externref" });
      if (at && at.kind !== "externref") coerceType(ctx, fctx, at, { kind: "externref" });
      else if (!at) fctx.body.push({ op: "ref.null.extern" });
    } else {
      fctx.body.push({ op: "ref.null.extern" });
    }
    argLocal = allocLocal(fctx, `__xr_pp_arg_${fctx.locals.length}`, { kind: "externref" });
    fctx.body.push({ op: "local.set", index: argLocal });
  }
  // isVec = OR of ref.test over every registered vec carrier.
  const anyTmp = allocLocal(fctx, `__xr_pp_any_${fctx.locals.length}`, { kind: "anyref" } as ValType);
  fctx.body.push({ op: "local.get", index: recvLocal });
  fctx.body.push({ op: "any.convert_extern" });
  fctx.body.push({ op: "local.set", index: anyTmp });
  let emitted = false;
  for (const vi of new Set(ctx.vecTypeMap.values())) {
    fctx.body.push({ op: "local.get", index: anyTmp });
    fctx.body.push({ op: "ref.test", typeIdx: vi });
    if (emitted) fctx.body.push({ op: "i32.or" });
    emitted = true;
  }
  if (!emitted) {
    fctx.body.push({ op: "i32.const", value: 0 });
  }
  // THEN arm: native vec op through the exported helper.
  const thenStart = fctx.body.length;
  if (methodName === "push") {
    fctx.body.push({ op: "local.get", index: recvLocal });
    fctx.body.push({ op: "local.get", index: argLocal! });
    fctx.body.push({ op: "call", funcIdx: vecOpIdx }); // -> i32 new length
    fctx.body.push({ op: "f64.convert_i32_s" });
    fctx.body.push({ op: "call", funcIdx: boxNumIdx! }); // -> externref
  } else {
    fctx.body.push({ op: "local.get", index: recvLocal });
    fctx.body.push({ op: "call", funcIdx: vecOpIdx }); // -> externref
  }
  const thenInstrs = fctx.body.splice(thenStart);
  // ELSE arm: host bridge.
  const elseStart = fctx.body.length;
  fctx.body.push({ op: "call", funcIdx: arrNewIdx });
  const argsLocal = allocLocal(fctx, `__xr_pp_args_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: argsLocal });
  if (methodName === "push") {
    fctx.body.push({ op: "local.get", index: argsLocal });
    fctx.body.push({ op: "local.get", index: argLocal! });
    fctx.body.push({ op: "call", funcIdx: arrPushIdx });
  }
  fctx.body.push({ op: "local.get", index: recvLocal });
  fctx.body.push(...stringConstantExternrefInstrs(ctx, methodName));
  fctx.body.push({ op: "local.get", index: argsLocal });
  fctx.body.push({ op: "call", funcIdx: mcIdx });
  const elseInstrs = fctx.body.splice(elseStart);
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "externref" } },
    then: thenInstrs,
    else: elseInstrs,
  });
  return { kind: "externref" };
}

function compileArrayPush(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
): ValType | null {
  // 0-arg push: no-op, return current length
  if (callExpr.arguments.length === 0) {
    const vecTmp0 = allocLocal(fctx, `__arr_push_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
    compileExpression(ctx, fctx, propAccess.expression);
    fctx.body.push({ op: "local.tee", index: vecTmp0 });
    emitReceiverNullGuard(ctx, fctx, vecTmp0, propAccess.expression);
    fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
    if (!ctx.fast) fctx.body.push({ op: "f64.convert_i32_s" });
    return ctx.fast ? { kind: "i32" } : { kind: "f64" };
  }

  const argCount = callExpr.arguments.length;
  const presizedCountedPush = fctx.presizedArrayPushCalls?.get(callExpr) === vecTypeIdx;
  const vecTmp = allocLocal(fctx, `__arr_push_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const dataTmp = allocLocal(fctx, `__arr_push_data_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const lenTmp = allocLocal(fctx, `__arr_push_len_${fctx.locals.length}`, { kind: "i32" });
  const newCapTmp = allocLocal(fctx, `__arr_push_ncap_${fctx.locals.length}`, { kind: "i32" });
  const newDataTmp = allocLocal(fctx, `__arr_push_ndata_${fctx.locals.length}`, {
    kind: "ref_null",
    typeIdx: arrTypeIdx,
  });

  // Compile receiver -> vec ref
  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.tee", index: vecTmp });
  if (!presizedCountedPush) emitReceiverNullGuard(ctx, fctx, vecTmp, propAccess.expression);

  // Get length
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenTmp });

  // Get data array
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataTmp });

  if (!presizedCountedPush) {
    // Check: length + argCount > capacity?
    fctx.body.push({ op: "local.get", index: dataTmp });
    fctx.body.push({ op: "array.len" });
    fctx.body.push({ op: "local.get", index: lenTmp });
    fctx.body.push({ op: "i32.const", value: argCount });
    fctx.body.push({ op: "i32.add" });
    fctx.body.push({ op: "i32.lt_s" });

    // if (capacity < length + argCount) -> grow
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [
        // newCap = max((len + argCount) * 2, 4)
        { op: "local.get", index: lenTmp },
        { op: "i32.const", value: argCount },
        { op: "i32.add" },
        { op: "i32.const", value: 1 },
        { op: "i32.shl" }, // (len + argCount) * 2
        { op: "i32.const", value: 4 },
        // select: if (len+argCount)*2 > 4 then (len+argCount)*2 else 4
        { op: "local.get", index: lenTmp },
        { op: "i32.const", value: argCount },
        { op: "i32.add" },
        { op: "i32.const", value: 1 },
        { op: "i32.shl" },
        { op: "i32.const", value: 4 },
        { op: "i32.gt_s" },
        { op: "select" },
        { op: "local.set", index: newCapTmp },

        // newData = array.new_default(newCap)
        { op: "local.get", index: newCapTmp },
        { op: "array.new_default", typeIdx: arrTypeIdx },
        { op: "local.set", index: newDataTmp },

        // array.copy newData[0..len] = data[0..len]
        { op: "local.get", index: newDataTmp },
        { op: "i32.const", value: 0 },
        { op: "local.get", index: dataTmp },
        { op: "i32.const", value: 0 },
        { op: "local.get", index: lenTmp },
        { op: "array.copy", dstTypeIdx: arrTypeIdx, srcTypeIdx: arrTypeIdx },

        // Update vec struct data field
        { op: "local.get", index: vecTmp },
        { op: "local.get", index: newDataTmp },
        { op: "ref.as_non_null" },
        { op: "struct.set", typeIdx: vecTypeIdx, fieldIdx: 1 },

        // Update local data pointer
        { op: "local.get", index: newDataTmp },
        { op: "local.set", index: dataTmp },
      ],
    });
  }

  // Set elements: data[length + i] = args[i] for each argument (compile-time unrolled)
  for (let i = 0; i < argCount; i++) {
    fctx.body.push({ op: "local.get", index: dataTmp });
    fctx.body.push({ op: "local.get", index: lenTmp });
    if (i > 0) {
      fctx.body.push({ op: "i32.const", value: i });
      fctx.body.push({ op: "i32.add" });
    }
    compileExpression(ctx, fctx, callExpr.arguments[i]!, elemType);
    fctx.body.push({ op: "array.set", typeIdx: arrTypeIdx });
  }

  // Update length: vec.length = len + argCount
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "local.get", index: lenTmp });
  fctx.body.push({ op: "i32.const", value: argCount });
  fctx.body.push({ op: "i32.add" });
  fctx.body.push({ op: "struct.set", typeIdx: vecTypeIdx, fieldIdx: 0 });

  // Return new length (i32 in fast mode, f64 otherwise)
  fctx.body.push({ op: "local.get", index: lenTmp });
  fctx.body.push({ op: "i32.const", value: argCount });
  fctx.body.push({ op: "i32.add" });
  if (!ctx.fast) fctx.body.push({ op: "f64.convert_i32_s" });
  return ctx.fast ? { kind: "i32" } : { kind: "f64" };
}

/**
 * JS-host `vec.push(...source)` for a runtime-sized array source.
 *
 * The receiver remains a native Wasm vec. The spread source crosses as an
 * externref so the existing generic length/index bridge can read either a
 * native vec mirror or an ordinary host array. Capture the source length before
 * growing so `a.push(...a)` appends exactly the original prefix.
 */
function compileArrayPushDynamicSpread(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  spreadExpression: ts.Expression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
): ValType | undefined {
  const sourceInfo = resolveArrayInfoFromWasmType(ctx, inferExpressionWasmType(ctx, fctx, spreadExpression));
  if (sourceInfo) {
    return compileArrayPushDynamicSpreadNative(
      ctx,
      fctx,
      propAccess,
      spreadExpression,
      vecTypeIdx,
      arrTypeIdx,
      elemType,
      sourceInfo.vecTypeIdx,
      sourceInfo.arrTypeIdx,
      sourceInfo.elemType,
    );
  }

  return compileArrayPushDynamicSpreadHost(ctx, fctx, propAccess, spreadExpression, vecTypeIdx, arrTypeIdx, elemType);
}

/**
 * A single dynamic spread contributes its runtime element count, not one
 * nested array value. This is Hono's `routes.push(...ownRoute)` shape: the
 * fixed unrolled push sees one AST argument and would append the whole source
 * vec as one row, so a later `route[0]` would read another array.
 */
function tryCompileArrayPushDynamicSpread(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  receiverIsExternref: boolean,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
): ValType | undefined {
  if (
    receiverIsExternref ||
    ctx.standalone ||
    ctx.wasi ||
    callExpr.arguments.length !== 1 ||
    !ts.isSpreadElement(callExpr.arguments[0]!)
  ) {
    return undefined;
  }
  return compileArrayPushDynamicSpread(
    ctx,
    fctx,
    propAccess,
    callExpr.arguments[0]!.expression,
    vecTypeIdx,
    arrTypeIdx,
    elemType,
  );
}

/** Copy a runtime-sized native vec spread without losing typed elements at the host boundary. */
function compileArrayPushDynamicSpreadNative(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  spreadExpression: ts.Expression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
  sourceVecTypeIdx: number,
  sourceArrTypeIdx: number,
  sourceStorageElemType: ValType,
): ValType {
  const receiverLocal = allocLocal(fctx, `__arr_spr_recv_${fctx.locals.length}`, {
    kind: "ref_null",
    typeIdx: vecTypeIdx,
  });
  const sourceLocal = allocLocal(fctx, `__arr_spr_native_${fctx.locals.length}`, {
    kind: "ref_null",
    typeIdx: sourceVecTypeIdx,
  });
  const sourceDataLocal = allocLocal(fctx, `__arr_spr_sdata_${fctx.locals.length}`, {
    kind: "ref_null",
    typeIdx: sourceArrTypeIdx,
  });
  const sourceLengthLocal = allocLocal(fctx, `__arr_spr_slen_${fctx.locals.length}`, { kind: "i32" });
  const oldLengthLocal = allocLocal(fctx, `__arr_spr_olen_${fctx.locals.length}`, { kind: "i32" });
  const neededLengthLocal = allocLocal(fctx, `__arr_spr_need_${fctx.locals.length}`, { kind: "i32" });
  const dataLocal = allocLocal(fctx, `__arr_spr_data_${fctx.locals.length}`, {
    kind: "ref_null",
    typeIdx: arrTypeIdx,
  });
  const indexLocal = allocLocal(fctx, `__arr_spr_i_${fctx.locals.length}`, { kind: "i32" });

  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.tee", index: receiverLocal });
  emitReceiverNullGuard(ctx, fctx, receiverLocal, propAccess.expression);
  fctx.body.push({ op: "drop" });

  const sourceExpected: ValType = { kind: "ref_null", typeIdx: sourceVecTypeIdx };
  const sourceType = compileExpression(ctx, fctx, spreadExpression, sourceExpected);
  if (sourceType) coerceType(ctx, fctx, sourceType, sourceExpected);
  else fctx.body.push({ op: "ref.null", typeIdx: sourceVecTypeIdx });
  fctx.body.push({ op: "local.tee", index: sourceLocal });
  emitReceiverNullGuard(ctx, fctx, sourceLocal, spreadExpression);
  fctx.body.push({ op: "struct.get", typeIdx: sourceVecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: sourceLengthLocal });
  fctx.body.push({ op: "local.get", index: sourceLocal });
  fctx.body.push({ op: "struct.get", typeIdx: sourceVecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: sourceDataLocal });

  fctx.body.push({ op: "local.get", index: receiverLocal });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.tee", index: oldLengthLocal });
  fctx.body.push({ op: "local.get", index: sourceLengthLocal });
  fctx.body.push({ op: "i32.add" });
  fctx.body.push({ op: "local.set", index: neededLengthLocal });

  fctx.body.push({ op: "local.get", index: receiverLocal });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataLocal });
  emitEnsureBackingCapacity(fctx, receiverLocal, dataLocal, vecTypeIdx, arrTypeIdx, neededLengthLocal);

  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: indexLocal });
  const sourceValueType = unpackedElemType(sourceStorageElemType);
  const loopBody: Instr[] = [
    { op: "local.get", index: indexLocal },
    { op: "local.get", index: sourceLengthLocal },
    { op: "i32.ge_s" },
    { op: "br_if", depth: 1 },
    { op: "local.get", index: dataLocal },
    { op: "local.get", index: oldLengthLocal },
    { op: "local.get", index: indexLocal },
    { op: "i32.add" },
    { op: "local.get", index: sourceDataLocal },
    { op: "local.get", index: indexLocal },
    { op: elemGetOp(sourceStorageElemType, undefined), typeIdx: sourceArrTypeIdx },
    ...coercionInstrs(ctx, sourceValueType, elemType, fctx),
    { op: "array.set", typeIdx: arrTypeIdx },
    { op: "local.get", index: indexLocal },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.set", index: indexLocal },
    { op: "br", depth: 0 },
  ];
  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [{ op: "loop", blockType: { kind: "empty" }, body: loopBody }],
  });

  fctx.body.push({ op: "local.get", index: receiverLocal });
  fctx.body.push({ op: "local.get", index: neededLengthLocal });
  fctx.body.push({ op: "struct.set", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.get", index: neededLengthLocal });
  if (!ctx.fast) fctx.body.push({ op: "f64.convert_i32_s" });
  return ctx.fast ? { kind: "i32" } : { kind: "f64" };
}

function compileArrayPushDynamicSpreadHost(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  spreadExpression: ts.Expression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
): ValType | undefined {
  // A spread row can itself be a vec with a different concrete carrier than
  // the destination element type (Hono's route-table arrays are this shape).
  // Reserve the shared host/cross-representation materializer before the
  // late-import flush; the generic externref coercion otherwise guarded-casts
  // the row to the destination carrier and silently stores null on a mismatch.
  const elementVecMaterializer =
    elemType.kind === "ref" || elemType.kind === "ref_null"
      ? buildVecFromExternMaterializer(ctx, elemType.typeIdx)
      : undefined;
  const lengthIdx = ensureLateImport(ctx, "__extern_length", [{ kind: "externref" }], [{ kind: "f64" }]);
  const getIdx = ensureLateImport(
    ctx,
    "__extern_get_idx",
    [{ kind: "externref" }, { kind: "f64" }],
    [{ kind: "externref" }],
  );
  flushLateImportShifts(ctx, fctx);
  if (lengthIdx === undefined || getIdx === undefined) return undefined;

  const receiverLocal = allocLocal(fctx, `__arr_spr_recv_${fctx.locals.length}`, {
    kind: "ref_null",
    typeIdx: vecTypeIdx,
  });
  const sourceLocal = allocLocal(fctx, `__arr_spr_src_${fctx.locals.length}`, { kind: "externref" });
  const sourceLengthLocal = allocLocal(fctx, `__arr_spr_slen_${fctx.locals.length}`, { kind: "i32" });
  const oldLengthLocal = allocLocal(fctx, `__arr_spr_olen_${fctx.locals.length}`, { kind: "i32" });
  const neededLengthLocal = allocLocal(fctx, `__arr_spr_need_${fctx.locals.length}`, { kind: "i32" });
  const dataLocal = allocLocal(fctx, `__arr_spr_data_${fctx.locals.length}`, {
    kind: "ref_null",
    typeIdx: arrTypeIdx,
  });
  const indexLocal = allocLocal(fctx, `__arr_spr_i_${fctx.locals.length}`, { kind: "i32" });

  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.tee", index: receiverLocal });
  emitReceiverNullGuard(ctx, fctx, receiverLocal, propAccess.expression);
  fctx.body.push({ op: "drop" });

  const sourceType = compileExpression(ctx, fctx, spreadExpression, { kind: "externref" });
  if (sourceType === null) {
    fctx.body.push({ op: "ref.null.extern" });
  } else if (sourceType.kind !== "externref") {
    coerceType(ctx, fctx, sourceType, { kind: "externref" });
  }
  fctx.body.push({ op: "local.set", index: sourceLocal });

  fctx.body.push({ op: "local.get", index: sourceLocal });
  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__extern_length") ?? lengthIdx });
  fctx.body.push({ op: "i32.trunc_sat_f64_s" });
  fctx.body.push({ op: "local.set", index: sourceLengthLocal });

  fctx.body.push({ op: "local.get", index: receiverLocal });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.tee", index: oldLengthLocal });
  fctx.body.push({ op: "local.get", index: sourceLengthLocal });
  fctx.body.push({ op: "i32.add" });
  fctx.body.push({ op: "local.set", index: neededLengthLocal });

  fctx.body.push({ op: "local.get", index: receiverLocal });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataLocal });
  emitEnsureBackingCapacity(fctx, receiverLocal, dataLocal, vecTypeIdx, arrTypeIdx, neededLengthLocal);

  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: indexLocal });
  const materializeElement: Instr[] = elementVecMaterializer
    ? [
        { op: "call", funcIdx: ctx.funcMap.get(elementVecMaterializer)! },
        ...(elemType.kind === "ref" ? ([{ op: "ref.as_non_null" }] satisfies Instr[]) : []),
      ]
    : coercionInstrs(ctx, { kind: "externref" }, elemType, fctx);
  const loopBody: Instr[] = [
    { op: "local.get", index: indexLocal },
    { op: "local.get", index: sourceLengthLocal },
    { op: "i32.ge_s" },
    { op: "br_if", depth: 1 },
    { op: "local.get", index: dataLocal },
    { op: "local.get", index: oldLengthLocal },
    { op: "local.get", index: indexLocal },
    { op: "i32.add" },
    { op: "local.get", index: sourceLocal },
    { op: "local.get", index: indexLocal },
    { op: "f64.convert_i32_s" },
    { op: "call", funcIdx: ctx.funcMap.get("__extern_get_idx") ?? getIdx },
    ...materializeElement,
    { op: "array.set", typeIdx: arrTypeIdx },
    { op: "local.get", index: indexLocal },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.set", index: indexLocal },
    { op: "br", depth: 0 },
  ];
  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [{ op: "loop", blockType: { kind: "empty" }, body: loopBody }],
  });

  fctx.body.push({ op: "local.get", index: receiverLocal });
  fctx.body.push({ op: "local.get", index: neededLengthLocal });
  fctx.body.push({ op: "struct.set", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.get", index: neededLengthLocal });
  if (!ctx.fast) fctx.body.push({ op: "f64.convert_i32_s" });
  return ctx.fast ? { kind: "i32" } : { kind: "f64" };
}

/**
 * arr.pop() -> O(1), decrement length and return last element.
 */
function compileArrayPop(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
  expectedType?: ValType,
): ValType | null {
  const resultType: ValType = shouldReturnUndefinedCapableResult(ctx, callExpr, expectedType)
    ? { kind: "externref" }
    : elemType;
  const vecTmp = allocLocal(fctx, `__arr_pop_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const newLenTmp = allocLocal(fctx, `__arr_pop_nl_${fctx.locals.length}`, { kind: "i32" });
  const resultTmp = allocLocal(fctx, `__arr_pop_res_${fctx.locals.length}`, resultType);

  const getOp = elemType.kind === "i8" ? "array.get_u" : elemType.kind === "i16" ? "array.get_s" : "array.get";
  const lenTmp = allocLocal(fctx, `__arr_pop_len_${fctx.locals.length}`, { kind: "i32" });

  // ECMA-262 §23.1.3.22: when length is 0, pop sets length to +0 and
  // returns undefined. Preserve the old primitive result only for numeric
  // hint contexts; otherwise use an externref result that can carry
  // undefined for the Array<T>.pop(): T | undefined signature.
  if (resultType.kind === "externref" || resultType.kind === "anyref") {
    emitUndefined(ctx, fctx);
    fctx.body.push({ op: "local.set", index: resultTmp });
  }

  // Compile receiver -> vec ref
  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.tee", index: vecTmp });
  emitReceiverNullGuard(ctx, fctx, vecTmp);

  // Get length
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenTmp });

  // Guard: if length > 0, do pop; else result stays as initialized above (undefined for ref types).
  fctx.body.push({ op: "local.get", index: lenTmp });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "i32.gt_s" });

  // (#2001 S1) If the popped slot is a `$Hole`, return `undefined`. The result
  // is externref here (resultType externref + `emitUndefined` already ran above,
  // so `__get_undefined` is registered — the detached map won't shift a funcIdx).
  const popHoleMap: Instr[] =
    ctx.usesArrayHoles && resultType.kind === "externref" && elemType.kind === "externref"
      ? holeToUndefinedInstrs(ctx, fctx)
      : [];

  // The `result = data[newLen]` element read.
  const popReadInstrs: Instr[] = [
    { op: "local.get", index: vecTmp },
    { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 },
    { op: "local.get", index: newLenTmp },
    { op: getOp, typeIdx: arrTypeIdx },
    ...popHoleMap,
    ...(resultType.kind === "externref" ? arrayElementToExternrefInstrs(ctx, fctx, elemType) : []),
    { op: "local.set", index: resultTmp },
  ];
  // (#3201) On a sparse array (logical `.length` > physical backing) `newLen`
  // can land beyond `array.len(data)`, so the raw `array.get` above TRAPS
  // ("array element access out of bounds"). Per §23.1.3.21 the popped slot is
  // then an absent index whose value is `undefined` — which `resultTmp` already
  // holds (initialised above). So gate the read on `newLen < array.len(data)`
  // and leave `resultTmp` at its `undefined` default when out of backing. Only
  // the externref-result (sparse `any[]`) lane can hit this — a numeric result
  // has no `undefined` sentinel and its backing always covers the length, so it
  // keeps the unguarded read. The length decrement is unconditional.
  const popReadGuarded: Instr[] =
    resultType.kind === "externref"
      ? [
          { op: "local.get", index: newLenTmp },
          { op: "local.get", index: vecTmp },
          { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 },
          { op: "array.len" },
          { op: "i32.lt_s" },
          { op: "if", blockType: { kind: "empty" }, then: popReadInstrs },
        ]
      : popReadInstrs;

  const thenInstrs: Instr[] = [
    // newLen = length - 1
    { op: "local.get", index: lenTmp },
    { op: "i32.const", value: 1 },
    { op: "i32.sub" },
    { op: "local.set", index: newLenTmp },
    // result = data[newLen] (bounds-guarded for sparse arrays)
    ...popReadGuarded,
    // Decrement length: vec.length = newLen
    { op: "local.get", index: vecTmp },
    { op: "local.get", index: newLenTmp },
    { op: "struct.set", typeIdx: vecTypeIdx, fieldIdx: 0 },
  ];

  fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: thenInstrs });

  // Return result (default value if empty, popped value if non-empty)
  fctx.body.push({ op: "local.get", index: resultTmp });
  return resultType;
}

/**
 * arr.shift() -> O(n) in-place: read data[0], shift data left, decrement length.
 */
function compileArrayShift(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
  expectedType?: ValType,
): ValType | null {
  const resultType: ValType = shouldReturnUndefinedCapableResult(ctx, callExpr, expectedType)
    ? { kind: "externref" }
    : elemType;
  const vecTmp = allocLocal(fctx, `__arr_sft_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const dataTmp = allocLocal(fctx, `__arr_sft_data_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const lenTmp = allocLocal(fctx, `__arr_sft_len_${fctx.locals.length}`, { kind: "i32" });
  const newLenTmp = allocLocal(fctx, `__arr_sft_nl_${fctx.locals.length}`, { kind: "i32" });
  const resultTmp = allocLocal(fctx, `__arr_sft_res_${fctx.locals.length}`, resultType);

  const getOp = elemType.kind === "i8" ? "array.get_u" : elemType.kind === "i16" ? "array.get_s" : "array.get";

  // ECMA-262 §23.1.3.27 mirrors pop's empty-array branch for shift.
  if (resultType.kind === "externref" || resultType.kind === "anyref") {
    emitUndefined(ctx, fctx);
    fctx.body.push({ op: "local.set", index: resultTmp });
  }

  // Compile receiver -> vec ref
  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.tee", index: vecTmp });
  emitReceiverNullGuard(ctx, fctx, vecTmp);

  // Get length
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenTmp });

  // Get data
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataTmp });

  // Guard: if length > 0, do shift; else result stays default (0/NaN/null)
  fctx.body.push({ op: "local.get", index: lenTmp });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "i32.gt_s" });

  // (#2001 S1) A shifted `$Hole` slot returns `undefined`. `emitUndefined` ran
  // above for the externref result, so `__get_undefined` is already registered.
  const shiftHoleMap: Instr[] =
    ctx.usesArrayHoles && resultType.kind === "externref" && elemType.kind === "externref"
      ? holeToUndefinedInstrs(ctx, fctx)
      : [];

  const thenInstrs: Instr[] = [
    // result = data[0]
    { op: "local.get", index: dataTmp },
    { op: "i32.const", value: 0 },
    { op: getOp, typeIdx: arrTypeIdx },
    ...shiftHoleMap,
    ...(resultType.kind === "externref" ? arrayElementToExternrefInstrs(ctx, fctx, elemType) : []),
    { op: "local.set", index: resultTmp },
    // newLen = len - 1
    { op: "local.get", index: lenTmp },
    { op: "i32.const", value: 1 },
    { op: "i32.sub" },
    { op: "local.set", index: newLenTmp },
    // Shift left: array.copy data[0..newLen] = data[1..len]
    { op: "local.get", index: dataTmp },
    { op: "i32.const", value: 0 },
    { op: "local.get", index: dataTmp },
    { op: "i32.const", value: 1 },
    { op: "local.get", index: newLenTmp },
    { op: "array.copy", dstTypeIdx: arrTypeIdx, srcTypeIdx: arrTypeIdx },
    // Decrement length: vec.length = newLen
    { op: "local.get", index: vecTmp },
    { op: "local.get", index: newLenTmp },
    { op: "struct.set", typeIdx: vecTypeIdx, fieldIdx: 0 },
  ];

  fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: thenInstrs });

  // Return result (default value if empty, shifted value if non-empty)
  fctx.body.push({ op: "local.get", index: resultTmp });
  return resultType;
}

/**
 * arr.unshift(...items) -> O(n) in-place: grow if needed, shift existing
 * elements right by argCount, write items into [0..argCount), bump length.
 * Returns the new length. The mirror of shift; §23.1.3.34.
 *
 * #1966: previously `unshift` was not in ARRAY_METHODS at all, so it fell
 * through to the host-import generic path which never wrote the mutation back
 * to the WasmGC vec — a silent no-op (host) / corruption (standalone). This is
 * the native lowering.
 */
function compileArrayUnshift(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
): ValType | null {
  // 0-arg unshift: no-op, return current length.
  if (callExpr.arguments.length === 0) {
    const vecTmp0 = allocLocal(fctx, `__arr_unsft_vec_${fctx.locals.length}`, {
      kind: "ref_null",
      typeIdx: vecTypeIdx,
    });
    compileExpression(ctx, fctx, propAccess.expression);
    fctx.body.push({ op: "local.tee", index: vecTmp0 });
    emitReceiverNullGuard(ctx, fctx, vecTmp0, propAccess.expression);
    fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
    if (!ctx.fast) fctx.body.push({ op: "f64.convert_i32_s" });
    return ctx.fast ? { kind: "i32" } : { kind: "f64" };
  }

  const argCount = callExpr.arguments.length;
  const vecTmp = allocLocal(fctx, `__arr_unsft_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const dataTmp = allocLocal(fctx, `__arr_unsft_data_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const lenTmp = allocLocal(fctx, `__arr_unsft_len_${fctx.locals.length}`, { kind: "i32" });
  const newCapTmp = allocLocal(fctx, `__arr_unsft_ncap_${fctx.locals.length}`, { kind: "i32" });
  const newDataTmp = allocLocal(fctx, `__arr_unsft_ndata_${fctx.locals.length}`, {
    kind: "ref_null",
    typeIdx: arrTypeIdx,
  });

  // Compile receiver -> vec ref
  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.tee", index: vecTmp });
  emitReceiverNullGuard(ctx, fctx, vecTmp, propAccess.expression);

  // Get length
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenTmp });

  // Get data array
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataTmp });

  // Capacity check: len + argCount > capacity? If so, allocate a new buffer and
  // copy the existing elements directly into their shifted destination
  // (data[0..len] -> newData[argCount..argCount+len]); otherwise array.copy
  // in place (overlapping copy is memmove-correct).
  fctx.body.push({ op: "local.get", index: dataTmp });
  fctx.body.push({ op: "array.len" });
  fctx.body.push({ op: "local.get", index: lenTmp });
  fctx.body.push({ op: "i32.const", value: argCount });
  fctx.body.push({ op: "i32.add" });
  fctx.body.push({ op: "i32.lt_s" }); // capacity < len + argCount
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [
      // newCap = max((len + argCount) * 2, 4)
      { op: "local.get", index: lenTmp },
      { op: "i32.const", value: argCount },
      { op: "i32.add" },
      { op: "i32.const", value: 1 },
      { op: "i32.shl" },
      { op: "i32.const", value: 4 },
      { op: "local.get", index: lenTmp },
      { op: "i32.const", value: argCount },
      { op: "i32.add" },
      { op: "i32.const", value: 1 },
      { op: "i32.shl" },
      { op: "i32.const", value: 4 },
      { op: "i32.gt_s" },
      { op: "select" },
      { op: "local.set", index: newCapTmp },

      // newData = array.new_default(newCap)
      { op: "local.get", index: newCapTmp },
      { op: "array.new_default", typeIdx: arrTypeIdx },
      { op: "local.set", index: newDataTmp },

      // newData[argCount .. argCount+len] = data[0..len]
      { op: "local.get", index: newDataTmp },
      { op: "i32.const", value: argCount },
      { op: "local.get", index: dataTmp },
      { op: "i32.const", value: 0 },
      { op: "local.get", index: lenTmp },
      { op: "array.copy", dstTypeIdx: arrTypeIdx, srcTypeIdx: arrTypeIdx },

      // Update vec struct data field + local pointer
      { op: "local.get", index: vecTmp },
      { op: "local.get", index: newDataTmp },
      { op: "ref.as_non_null" },
      { op: "struct.set", typeIdx: vecTypeIdx, fieldIdx: 1 },
      { op: "local.get", index: newDataTmp },
      { op: "local.set", index: dataTmp },
    ],
    else: [
      // In-place right shift: data[argCount .. argCount+len] = data[0..len].
      // array.copy is memmove-safe for overlapping ranges.
      { op: "local.get", index: dataTmp },
      { op: "i32.const", value: argCount },
      { op: "local.get", index: dataTmp },
      { op: "i32.const", value: 0 },
      { op: "local.get", index: lenTmp },
      { op: "array.copy", dstTypeIdx: arrTypeIdx, srcTypeIdx: arrTypeIdx },
    ],
  });

  // Write the new elements into data[0..argCount) (compile-time unrolled).
  for (let i = 0; i < argCount; i++) {
    fctx.body.push({ op: "local.get", index: dataTmp });
    fctx.body.push({ op: "i32.const", value: i });
    compileExpression(ctx, fctx, callExpr.arguments[i]!, elemType);
    fctx.body.push({ op: "array.set", typeIdx: arrTypeIdx });
  }

  // Update length: vec.length = len + argCount
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "local.get", index: lenTmp });
  fctx.body.push({ op: "i32.const", value: argCount });
  fctx.body.push({ op: "i32.add" });
  fctx.body.push({ op: "struct.set", typeIdx: vecTypeIdx, fieldIdx: 0 });

  // Return new length (i32 in fast mode, f64 otherwise).
  fctx.body.push({ op: "local.get", index: lenTmp });
  fctx.body.push({ op: "i32.const", value: argCount });
  fctx.body.push({ op: "i32.add" });
  if (!ctx.fast) fctx.body.push({ op: "f64.convert_i32_s" });
  return ctx.fast ? { kind: "i32" } : { kind: "f64" };
}

/**
 * arr.slice(start?, end?) -> create new vec struct with sliced data.
 */
/**
 * #1359 Slice E (sparse holes): for `__vec_*` typed receivers, no holes
 * are possible at the WasmGC level — the underlying typed array is
 * dense by construction. Spec §23.1.3.x's `HasProperty(O, k)` checks
 * before `Get(O, k)` are therefore vacuously true for every k in
 * `[start, end)`. We can `array.copy` the underlying buffer without
 * iterating per-index. Host-array receivers (sparse, with prototype-
 * inherited slots) flow through `__proto_method_call` which delegates
 * to native `Array.prototype.slice` and gets the spec semantics for
 * free. See sub-slice plan in the issue file for the full rationale.
 *
 * #1359 Slice A (empty-slice "actual: null"): NOT a slice() bug. The
 * vec returned by this function is non-null (struct.new always returns
 * non-null). The "actual: null" failure observed in
 * `slice/S15.4.4.10_A1.1_T4.js` is downstream — the test calls
 * `Object.prototype.toString.call(arr)` which needs the $vec brand to
 * resolve to "[object Array]". That's #1334 territory.
 */
function compileArraySlice(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  _elemType: ValType,
): ValType {
  const vecTmp = allocLocal(fctx, `__arr_slc_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });

  // Compile receiver -> vec ref, stash in vecTmp, null-guard, drop the tee leftover.
  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.tee", index: vecTmp });
  emitReceiverNullGuard(ctx, fctx, vecTmp);
  fctx.body.push({ op: "drop" });

  // start arg (f64→i32) into a local; default 0.
  const startTmp = allocLocal(fctx, `__arr_slc_s_${fctx.locals.length}`, { kind: "i32" });
  if (callExpr.arguments.length >= 1) {
    compileExpression(ctx, fctx, callExpr.arguments[0]!, { kind: "f64" });
    fctx.body.push({ op: "i32.trunc_sat_f64_s" });
  } else {
    fctx.body.push({ op: "i32.const", value: 0 });
  }
  fctx.body.push({ op: "local.set", index: startTmp });

  // end arg into a local (only when explicit); null = "use length".
  // (#3201) §23.1.3.25 step 6: an explicit `undefined` end is spec-equivalent to
  // an OMITTED end (relativeEnd = len), NOT `ToIntegerOrInfinity(undefined)` = 0.
  // Compiling `undefined` in f64 context yields `f64.const NaN` → `trunc_sat` = 0,
  // which turned `x.slice(3, undefined)` into an empty slice instead of `x.slice(3)`.
  // Treat a statically-`undefined` end (the literal, or the `undefined` global) as
  // "no end". A literal/identifier `undefined` has no side effects, so skipping its
  // compilation preserves observable evaluation order. (undefined START already
  // coerces correctly: ToIntegerOrInfinity(undefined) = 0 = the default.)
  const endArg = callExpr.arguments.length >= 2 ? callExpr.arguments[1]! : undefined;
  const endIsExplicitUndefined =
    !!endArg &&
    (endArg.kind === ts.SyntaxKind.UndefinedKeyword || (ts.isIdentifier(endArg) && endArg.text === "undefined"));
  const hasEnd = endArg !== undefined && !endIsExplicitUndefined;
  const endTmp = allocLocal(fctx, `__arr_slc_e_${fctx.locals.length}`, { kind: "i32" });
  if (hasEnd) {
    compileExpression(ctx, fctx, endArg!, { kind: "f64" });
    fctx.body.push({ op: "i32.trunc_sat_f64_s" });
    fctx.body.push({ op: "local.set", index: endTmp });
  }
  return compileArraySliceFromVecLocal(ctx, fctx, vecTmp, vecTypeIdx, arrTypeIdx, startTmp, hasEnd ? endTmp : null);
}

/**
 * (#2193 PR-B) Local-driven core of `Array.prototype.slice`: given the receiver
 * vec already in `vecLocal` and the (already-truncated-to-i32) start in
 * `startLocal`, produce a new sliced vec. `endLocal === null` means "no explicit
 * end" (use the receiver length). This is the AST-free entry the proto-member
 * closure body (`emitArrayProtoMemberBody`) calls after recovering the array
 * instance from the closure `this` externref. `compileArraySlice` is now a thin
 * wrapper that compiles the receiver/args into locals then delegates here — so the
 * direct `a.slice(...)` lowering is behaviour-preserving (pure extraction).
 */
export function compileArraySliceFromVecLocal(
  ctx: CodegenContext,
  fctx: FunctionContext,
  vecLocal: number,
  vecTypeIdx: number,
  arrTypeIdx: number,
  startLocal: number,
  endLocal: number | null,
): ValType {
  const dataTmp = allocLocal(fctx, `__arr_slc_data_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const newData = allocLocal(fctx, `__arr_slc_ndata_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const lenTmp = allocLocal(fctx, `__arr_slc_len_${fctx.locals.length}`, { kind: "i32" });
  const sliceLenTmp = allocLocal(fctx, `__arr_slc_sl_${fctx.locals.length}`, { kind: "i32" });

  // len = vec.length (field 0)
  fctx.body.push({ op: "local.get", index: vecLocal });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenTmp });

  // data = vec.data (field 1)
  fctx.body.push({ op: "local.get", index: vecLocal });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataTmp });

  // start clamp (negative → max(0, len+start); positive → min(start, len))
  emitClampIndex(fctx, startLocal, lenTmp);

  // end: explicit (clamp) or default = len.
  const endFin = allocLocal(fctx, `__arr_slc_efin_${fctx.locals.length}`, { kind: "i32" });
  if (endLocal !== null) {
    fctx.body.push({ op: "local.get", index: endLocal });
    fctx.body.push({ op: "local.set", index: endFin });
    emitClampIndex(fctx, endFin, lenTmp);
  } else {
    fctx.body.push({ op: "local.get", index: lenTmp });
    fctx.body.push({ op: "local.set", index: endFin });
  }

  // sliceLen = max(0, end - start)
  fctx.body.push({ op: "local.get", index: endFin });
  fctx.body.push({ op: "local.get", index: startLocal });
  fctx.body.push({ op: "i32.sub" });
  fctx.body.push({ op: "local.set", index: sliceLenTmp });
  emitClampNonNeg(fctx, sliceLenTmp);

  // newData = array.new_default(sliceLen)
  fctx.body.push({ op: "local.get", index: sliceLenTmp });
  fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
  fctx.body.push({ op: "local.set", index: newData });

  // (#3201) A sparse array (logical `.length` > physical backing) makes the
  // copy source range `[start, start+sliceLen)` run past `array.len(data)`, so
  // the `array.copy` below TRAPS ("array element access out of bounds"). The
  // result must stay `sliceLen` long — the beyond-backing tail is a hole (spec
  // skips absent indices), which the default-initialised `newData` already
  // represents. So copy only the in-backing prefix (guarded: a start past the
  // backing must skip the copy entirely — array.copy traps on an out-of-backing
  // srcOffset even at count 0).
  // (#5145) §23.1.3.25 step 8 — `A = ArraySpeciesCreate(O, count)`, emitted
  // BEFORE the element copy so an abrupt species completion beats it. Null
  // sentinel ⇒ the `struct.new $vec` below is the result, unchanged.
  const speciesDeps = prepareArraySpeciesDeps(ctx, fctx);
  const speciesLocal =
    speciesDeps === undefined
      ? undefined
      : emitArraySpeciesCreate(
          ctx,
          fctx,
          speciesDeps,
          [{ op: "local.get", index: vecLocal }, { op: "extern.convert_any" }],
          [{ op: "local.get", index: sliceLenTmp }, { op: "f64.convert_i32_s" }],
        );

  emitBackingClampedArrayCopy(ctx, fctx, arrTypeIdx, newData, null, dataTmp, startLocal, sliceLenTmp);

  // struct.new vec { sliceLen, newData }
  fctx.body.push({ op: "local.get", index: sliceLenTmp });
  fctx.body.push({ op: "local.get", index: newData });
  fctx.body.push({ op: "ref.as_non_null" });
  fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
  if (speciesDeps !== undefined && speciesLocal !== undefined) {
    return emitArraySpeciesResultSwap(ctx, fctx, speciesDeps, speciesLocal, {
      kind: "ref_null",
      typeIdx: vecTypeIdx,
    });
  }
  return { kind: "ref_null", typeIdx: vecTypeIdx };
}

/**
 * (#3201) Emit a copy-count clamped to the SOURCE array's physical backing so a
 * sparse vec (logical `.length` > `array.len(data)`) never `array.copy`s past
 * the backing — which traps ("array element access out of bounds"). Returns a
 * fresh i32 local holding `clamp(array.len(data) - start, 0, requestedLen)`.
 * The destination array keeps its full `requestedLen` slots; the beyond-backing
 * tail stays default-initialised (a hole, per the spec's skip of absent
 * indices). Non-sparse vecs are unaffected (backing capacity ≥ length ⇒ the
 * clamp == requestedLen). `startLocal === null` means a start offset of 0.
 */
function emitBackingClampedCopyLen(
  fctx: FunctionContext,
  dataLocal: number,
  startLocal: number | null,
  requestedLenLocal: number,
): number {
  const out = allocLocal(fctx, `__arr_copyclamp_${fctx.locals.length}`, { kind: "i32" });
  // avail = array.len(data) - start
  fctx.body.push({ op: "local.get", index: dataLocal });
  fctx.body.push({ op: "array.len" });
  if (startLocal !== null) {
    fctx.body.push({ op: "local.get", index: startLocal });
    fctx.body.push({ op: "i32.sub" });
  }
  fctx.body.push({ op: "local.set", index: out });
  emitClampNonNeg(fctx, out); // avail = max(0, avail)
  // out = min(requestedLen, avail)  (select returns first if cond, else second)
  fctx.body.push({ op: "local.get", index: requestedLenLocal });
  fctx.body.push({ op: "local.get", index: out });
  fctx.body.push({ op: "local.get", index: requestedLenLocal });
  fctx.body.push({ op: "local.get", index: out });
  fctx.body.push({ op: "i32.lt_s" });
  fctx.body.push({ op: "select" });
  fctx.body.push({ op: "local.set", index: out });
  return out;
}

/**
 * (#3201) Backing-safe `array.copy`: clamps the copy count to the SOURCE's
 * physical backing (via `emitBackingClampedCopyLen`) AND guards the copy on
 * `count > 0`. The guard is load-bearing, not an optimisation: per the WasmGC
 * spec `array.copy` traps when `srcOffset + count > array.len(src)` — and the
 * bound is checked even when `count == 0`, so a `srcOffset` past the backing
 * traps DESPITE a zero count. The clamp guarantees `srcOffset < backing`
 * whenever `count > 0`, so the guarded copy is always in bounds; when
 * `count == 0` the (default-initialised) destination is already correct and the
 * copy is skipped. Non-sparse arrays are unaffected (clamp == requested,
 * always > 0 for a real copy).
 */
function emitBackingClampedArrayCopy(
  ctx: CodegenContext,
  fctx: FunctionContext,
  arrTypeIdx: number,
  dstArr: number,
  dstOffset: number | null,
  srcArr: number,
  srcOffset: number | null,
  requestedLenLocal: number,
): void {
  const count = emitBackingClampedCopyLen(fctx, srcArr, srcOffset, requestedLenLocal);
  const copyInstrs = collectElemInstrs(ctx, fctx, () =>
    emitArrayCopy(fctx, arrTypeIdx, dstArr, dstOffset, srcArr, srcOffset, count),
  );
  fctx.body.push({ op: "local.get", index: count });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "i32.gt_s" });
  fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: copyInstrs });
}

/**
 * (#4638) Allocate concat's result backing so its BEYOND-BACKING tail reads as
 * absent, not as `0`.
 *
 * `array.new_default` zero-fills an f64 backing, and the two copies that follow
 * are BACKING-clamped (#3201) — a sparse operand (`a = [0]; a.length = 3`) has
 * fewer backing slots than its logical length, so the untouched destination
 * slots kept the default `0`. `a.concat()` then answered `b[1] === 0` where the
 * spec answers `undefined` (`S15.4.4.4_A3_T2`/`_T3`): a REAL element `0` was
 * invented where the source had none.
 *
 * `array.new` with the marker costs exactly what `array.new_default` costs (one
 * fill pass either way), and every slot the copies do reach is overwritten — so
 * a DENSE concat is unchanged in behaviour and in cost. Only the f64 carrier
 * needs it: `array.new_default` already yields `null` for an externref backing,
 * which the read boundary reports as absent.
 *
 * Marker choice follows the #4491 T8/T11 split: `HOLE_F64_BITS` when the
 * module's hole machinery is demand-gated ON (presence answers `absent` too),
 * `UNDEF_F64_BITS` otherwise — because with the gate OFF nothing canonicalises
 * `HOLE → UNDEF` at the read boundary and the marker would surface as a raw NaN.
 */
function emitConcatResultBacking(
  ctx: CodegenContext,
  fctx: FunctionContext,
  arrTypeIdx: number,
  elemType: ValType,
  lenLocal: number,
): void {
  if (elemType.kind !== "f64") {
    fctx.body.push({ op: "local.get", index: lenLocal });
    fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
    return;
  }
  fctx.body.push({ op: "i64.const", value: f64HolesActive(ctx) ? HOLE_F64_BITS : UNDEF_F64_BITS });
  fctx.body.push({ op: "f64.reinterpret_i64" });
  fctx.body.push({ op: "local.get", index: lenLocal });
  fctx.body.push({ op: "array.new", typeIdx: arrTypeIdx });
}

/** Native-first concat for array operands whose physical vec kinds differ. */
function compileArrayConcatNativeDynamic(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
): ValType | null {
  // (#4446) The spec loop subsumes this all-array-operands shortcut and is
  // strictly more correct on it: the shortcut spreads EVERY operand
  // unconditionally, which is wrong for an array carrying a falsy
  // `@@isConcatSpreadable` (is-concat-spreadable-val-falsey/-val-undefined).
  // Keep the original unconditional walk as the substrate-unavailable fallback.
  const spec = compileArrayConcatNativeSpec(ctx, fctx, propAccess, callExpr);
  if (spec !== undefined) return spec;

  const builders = ensureObjVecBuilders(ctx);
  const externLenIdx = ctx.funcMap.get("__extern_length");
  const externGetIdx = ctx.funcMap.get("__extern_get_idx");
  flushLateImportShifts(ctx, fctx);
  if (externLenIdx === undefined || externGetIdx === undefined) return null;

  const out = allocLocal(fctx, `__cat_native_out_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "call", funcIdx: builders.newIdx });
  fctx.body.push({ op: "local.set", index: out });

  // The caller admits only statically array-shaped operands. Walk each through
  // the native dynamic readers so differently specialized vecs, `$ObjVec`, and
  // an explicitly admitted caller-owned JS Array share one path. The result is
  // a fresh Wasm-owned `$ObjVec`; no JS shadow array is introduced.
  for (const sourceExpr of [propAccess.expression, ...callExpr.arguments]) {
    const source = allocLocal(fctx, `__cat_native_src_${fctx.locals.length}`, { kind: "externref" });
    const len = allocLocal(fctx, `__cat_native_len_${fctx.locals.length}`, { kind: "i32" });
    const index = allocLocal(fctx, `__cat_native_i_${fctx.locals.length}`, { kind: "i32" });

    const sourceType = compileExpression(ctx, fctx, sourceExpr, { kind: "externref" });
    if (sourceType === null) fctx.body.push({ op: "ref.null.extern" });
    else if (sourceType.kind !== "externref") coerceType(ctx, fctx, sourceType, { kind: "externref" });
    fctx.body.push({ op: "local.tee", index: source });
    fctx.body.push({ op: "call", funcIdx: externLenIdx });
    fctx.body.push({ op: "i32.trunc_sat_f64_s" });
    fctx.body.push({ op: "local.set", index: len });
    fctx.body.push({ op: "i32.const", value: 0 });
    fctx.body.push({ op: "local.set", index });
    fctx.body.push({
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index },
            { op: "local.get", index: len },
            { op: "i32.ge_u" },
            { op: "br_if", depth: 1 },
            { op: "local.get", index: out },
            { op: "local.get", index: source },
            { op: "local.get", index },
            { op: "f64.convert_i32_s" },
            { op: "call", funcIdx: externGetIdx },
            { op: "call", funcIdx: builders.pushIdx },
            { op: "local.get", index },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index },
            { op: "br", depth: 0 },
          ],
        },
      ],
    });
  }

  fctx.body.push({ op: "local.get", index: out });
  return { kind: "externref" };
}

/**
 * arr.concat(other) -> create new vec struct with combined data.
 */
function compileArrayConcat(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
): ValType | null {
  // (#4655) An index that resolves through the PROTOTYPE CHAIN is invisible to
  // every path below: they `array.copy` the receiver's own backing and never
  // perform `Get(O, k)`. §23.1.3.1 step 5.c.i is `HasProperty(E, k)` and 5.c.ii
  // is `Get(E, k)`, both full MOP walks. Route the whole call to the spec loop
  // when the module could observe the difference — the same `protoIndexDirty`
  // gate, and the same argument, as `array-join-proto-hole.ts` (#4491 lane J)
  // uses for `join`. Flag clear ⇒ not reached ⇒ bytes unchanged.
  // See array-concat-carrier.ts; the SLOT typers ask that same predicate.
  // (#5145) The same argument applies to `ArraySpeciesCreate`: every path below
  // mints a raw `struct.new $vec`, so a module that can observe `@@species`
  // must take the spec loop (which carries the species prologue) — including
  // the 0-arg shallow-copy shortcut, which `concat/create-species*.js` exercises
  // with a bare `a.concat()`.
  if (concatMustConsultPrototypeChain(ctx) || arraySpeciesActive(ctx)) {
    const spec = compileArrayConcatNativeSpec(ctx, fctx, propAccess, callExpr);
    if (spec !== undefined) return spec;
  }
  // 0-arg concat: shallow copy of the receiver array
  if (callExpr.arguments.length === 0) {
    const vecA = allocLocal(fctx, `__arr_cat_va_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
    const dataA = allocLocal(fctx, `__arr_cat_da_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
    const newData = allocLocal(fctx, `__arr_cat_nd_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
    const lenA = allocLocal(fctx, `__arr_cat_la_${fctx.locals.length}`, { kind: "i32" });

    // Compile receiver -> vec ref
    compileExpression(ctx, fctx, propAccess.expression);
    fctx.body.push({ op: "local.tee", index: vecA });
    emitReceiverNullGuard(ctx, fctx, vecA);
    fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
    fctx.body.push({ op: "local.set", index: lenA });
    fctx.body.push({ op: "local.get", index: vecA });
    fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
    fctx.body.push({ op: "local.set", index: dataA });

    // newData = backing of lenA slots, absent-marked (#4638 — see helper).
    emitConcatResultBacking(ctx, fctx, arrTypeIdx, elemType, lenA);
    fctx.body.push({ op: "local.set", index: newData });

    // array.copy newData[0..lenA] = dataA[0..lenA] — (#3201) backing-clamped +
    // guarded so a sparse receiver (lenA > array.len(dataA)) doesn't trap.
    emitBackingClampedArrayCopy(ctx, fctx, arrTypeIdx, newData, null, dataA, null, lenA);

    // Create new vec struct: { lenA, newData }
    fctx.body.push({ op: "local.get", index: lenA });
    fctx.body.push({ op: "local.get", index: newData });
    fctx.body.push({ op: "ref.as_non_null" });
    fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
    return { kind: "ref_null", typeIdx: vecTypeIdx };
  }

  // Check if argument B is a known WasmGC array type. If not (e.g. `any`, `object`,
  // array-like with Symbol.isConcatSpreadable), struct.get would cause an illegal cast at runtime.
  // Fall back to __extern_method_call("concat") for non-array arguments.
  //
  // #1359: Also bail if the arg's vec type differs from the receiver's vec type
  // (e.g. `[].concat([1, 2])` where the empty receiver is `__vec_externref` and the
  // arg is `__vec_f64`). The fast path emits `ref.cast` from the arg to the receiver's
  // vec type, which traps at runtime when the types don't match.
  //
  // #1359: Likewise bail when there are 2+ args; the typed fast path only handles a
  // single arg, but `Array.prototype.concat` accepts variadic args and the host
  // bridge handles them correctly.
  const argNode = callExpr.arguments[0]!;
  const argTsType = ctx.checker.getTypeAtLocation(argNode);
  const argArrayInfo = resolveArrayInfo(ctx, argTsType);
  const allArgumentsAreArrays = callExpr.arguments.every(
    (argument) => resolveArrayInfo(ctx, ctx.checker.getTypeAtLocation(argument)) !== null,
  );

  if (!argArrayInfo) {
    if (ctx.targetProfile.semanticProviders === "native-first" && allArgumentsAreArrays) {
      return compileArrayConcatNativeDynamic(ctx, fctx, propAccess, callExpr);
    }
    return compileArrayConcatExtern(ctx, fctx, propAccess, callExpr);
  }
  if (argArrayInfo.vecTypeIdx !== vecTypeIdx) {
    if (ctx.targetProfile.semanticProviders === "native-first" && allArgumentsAreArrays) {
      return compileArrayConcatNativeDynamic(ctx, fctx, propAccess, callExpr);
    }
    return compileArrayConcatExtern(ctx, fctx, propAccess, callExpr);
  }
  if (callExpr.arguments.length > 1) {
    if (ctx.targetProfile.semanticProviders === "native-first" && allArgumentsAreArrays) {
      return compileArrayConcatNativeDynamic(ctx, fctx, propAccess, callExpr);
    }
    return compileArrayConcatExtern(ctx, fctx, propAccess, callExpr);
  }

  const vecA = allocLocal(fctx, `__arr_cat_va_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const vecB = allocLocal(fctx, `__arr_cat_vb_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const dataA = allocLocal(fctx, `__arr_cat_da_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const dataB = allocLocal(fctx, `__arr_cat_db_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const newData = allocLocal(fctx, `__arr_cat_nd_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const lenA = allocLocal(fctx, `__arr_cat_la_${fctx.locals.length}`, { kind: "i32" });
  const lenB = allocLocal(fctx, `__arr_cat_lb_${fctx.locals.length}`, { kind: "i32" });
  const totalLen = allocLocal(fctx, `__arr_cat_tl_${fctx.locals.length}`, { kind: "i32" });

  // Compile receiver A -> vec ref
  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.tee", index: vecA });
  emitReceiverNullGuard(ctx, fctx, vecA);
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenA });
  fctx.body.push({ op: "local.get", index: vecA });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataA });

  // Compile argument B -> vec ref (safe — argArrayInfo confirmed it's a WasmGC array)
  compileExpression(ctx, fctx, callExpr.arguments[0]!);
  fctx.body.push({ op: "local.tee", index: vecB });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenB });
  fctx.body.push({ op: "local.get", index: vecB });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataB });

  // totalLen = lenA + lenB
  fctx.body.push({ op: "local.get", index: lenA });
  fctx.body.push({ op: "local.get", index: lenB });
  fctx.body.push({ op: "i32.add" });
  fctx.body.push({ op: "local.set", index: totalLen });

  // newData = backing of totalLen slots, absent-marked (#4638 — see helper).
  emitConcatResultBacking(ctx, fctx, arrTypeIdx, elemType, totalLen);
  fctx.body.push({ op: "local.set", index: newData });

  // array.copy newData[0..lenA] = dataA[0..lenA] — (#3201) clamp both copy
  // counts to each source's backing (and guard) so a sparse operand (logical
  // length > array.len(data)) doesn't array.copy past the backing (which
  // traps). The destination keeps totalLen slots; beyond-backing tails stay
  // default holes.
  emitBackingClampedArrayCopy(ctx, fctx, arrTypeIdx, newData, null, dataA, null, lenA);

  // array.copy newData[lenA..lenA+lenB] = dataB[0..lenB]
  emitBackingClampedArrayCopy(ctx, fctx, arrTypeIdx, newData, lenA, dataB, null, lenB);

  // Create new vec struct: { totalLen, newData }
  fctx.body.push({ op: "local.get", index: totalLen });
  fctx.body.push({ op: "local.get", index: newData });
  fctx.body.push({ op: "ref.as_non_null" });
  fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
  return { kind: "ref_null", typeIdx: vecTypeIdx };
}

/**
 * Fallback for arr.concat(arg...) when any arg is not a known WasmGC array type
 * (e.g. `any`, array-like with Symbol.isConcatSpreadable, or plain objects).
 *
 * (#4446) Per-target switch. `native-first` (`--target standalone` /
 * `--target wasi`) takes the Wasm-native §23.1.3.1 loop
 * ({@link compileArrayConcatNativeSpec}); everything else keeps the unchanged
 * `env::__array_concat_any` host bridge (`compileArrayConcatExternHost` in
 * array-method-host.ts), whose `env::*` imports the #2961 leak guard rejects
 * host-free.
 */
function compileArrayConcatExtern(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
): ValType | null {
  if (ctx.targetProfile.semanticProviders === "native-first") {
    const native = compileArrayConcatNativeSpec(ctx, fctx, propAccess, callExpr);
    if (native !== undefined) return native;
  }
  return compileArrayConcatExternHost(ctx, fctx, propAccess, callExpr);
}

/**
 * #1286: arr.join(sep?) fallback for externref receivers (e.g., the result of
 * `Object.keys(any)` via the `__object_keys` host import, which returns a real
 * JS array). The native `compileArrayJoin` path expects a WasmGC vec struct;
 * trying to extract one from an externref via `ref.cast` traps with "illegal
 * cast". Instead, delegate to the host's `Array.prototype.join` via the
 * `__array_join_any` import, which handles JS arrays and WasmGC vecs.
 */
/**
 * #3155 — standalone (`noJsHost`) `arr.join(sep?)` for an EXTERNREF receiver
 * (e.g. `Object.keys(any).join(",")`, whose receiver is a boxed array walked
 * via the native `__extern_length` / `__extern_get_idx` boundary).
 *
 * The host lane's {@link compileArrayJoinExtern} delegates to the JS
 * `__array_join_any` import, which is an unsatisfiable `env::*` import in
 * standalone mode (CLAUDE.md "Dual-mode: JS host optional"). This lane instead
 * walks the externref array natively — length via `__extern_length`, each
 * element via `__extern_get_idx` then ToString via `__extern_toString` (both
 * native-registered under standalone, the same helpers the receiver's `.length`
 * already uses host-free) — and folds with the shared {@link emitStringJoinFold}
 * over the native-string representation, mirroring {@link compileArrayJoinNative}.
 *
 * Returns `null` (⇒ caller falls back to the host import) when the native
 * string helpers are unavailable.
 */
function compileArrayJoinExternNative(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
): ValType | null {
  const repr = nativeStringRepr(ctx);
  const anyStrTypeIdx = ctx.anyStrTypeIdx;
  if (repr === undefined || anyStrTypeIdx < 0) return null;
  // (#4655) Armed FIRST so its import shifts settle before any funcIdx below is
  // read into a JS variable (the #2043 late-shift class).
  const localized = isLocalizedJoin(propAccess);
  const localizedArm = localized ? ensureElementToLocaleStringInvoke(ctx, fctx) : undefined;

  // Native extern-array boundary helpers. `__extern_length`/`__extern_get_idx`
  // carry f64 length/index (§ import-manifest); `__extern_toString` is the same
  // §7.1.17 ToString the boxed-any element path uses. All three have native
  // arms under standalone (the receiver's own `.length` read proves it), so
  // these `ensureLateImport`s resolve to the native funcs, not host imports.
  const externLenIdx = ensureLateImport(ctx, "__extern_length", [{ kind: "externref" }], [{ kind: "f64" }]);
  const externGetIdx = ensureLateImport(
    ctx,
    "__extern_get_idx",
    [{ kind: "externref" }, { kind: "f64" }],
    [{ kind: "externref" }],
  );
  const externToStrIdx = ensureLateImport(ctx, "__extern_toString", [{ kind: "externref" }], [{ kind: "externref" }]);
  flushLateImportShifts(ctx, fctx);
  if (externLenIdx === undefined || externGetIdx === undefined || externToStrIdx === undefined) return null;

  const recvTmp = allocLocal(fctx, `__ejoin_recv_${fctx.locals.length}`, { kind: "externref" });
  const foldLocals = allocJoinFoldLocals(fctx, repr, "ejoin");
  const { lenTmp, iTmp, resultTmp, sepTmp } = foldLocals;

  // Receiver → externref, retained in recvTmp. len = trunc(__extern_length(recv)).
  const recvType = compileExpression(ctx, fctx, propAccess.expression);
  if (recvType && recvType.kind !== "externref") fctx.body.push({ op: "extern.convert_any" });
  fctx.body.push({ op: "local.tee", index: recvTmp });
  fctx.body.push({ op: "call", funcIdx: externLenIdx });
  fctx.body.push({ op: "i32.trunc_sat_f64_s" });
  fctx.body.push({ op: "local.set", index: lenTmp });

  // Separator: explicit arg (coerced to a native string) or the spec default
  // ",". (#4655) `toLocaleString`'s arguments are the reserved locales/options,
  // never a separator, so `localized` keeps the default and does not compile
  // them at all.
  if (!localized && callExpr.arguments.length >= 1) {
    const argType = compileExpression(ctx, fctx, callExpr.arguments[0]!, { kind: "externref" });
    if (argType === null) {
      fctx.body.push(...nativeStringLiteralInstrs(ctx, ","));
    } else {
      fctx.body.push({ op: "any.convert_extern" });
      fctx.body.push({ op: "ref.cast", typeIdx: anyStrTypeIdx });
    }
  } else {
    fctx.body.push(...nativeStringLiteralInstrs(ctx, ","));
  }
  fctx.body.push({ op: "local.set", index: sepTmp });

  // result = "" (empty-array join is "", #1968) and i = 0.
  fctx.body.push(...nativeStringLiteralInstrs(ctx, ""));
  fctx.body.push({ op: "local.set", index: resultTmp });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: iTmp });

  // element → ref $AnyString: __extern_toString(__extern_get_idx(recv, i)) —
  // or (#4655) `ToString(Invoke(elem, "toLocaleString"))` under `localized`.
  const elemToStr: Instr[] = [
    { op: "local.get", index: recvTmp },
    { op: "local.get", index: iTmp },
    { op: "f64.convert_i32_s" },
    { op: "call", funcIdx: ctx.funcMap.get("__extern_get_idx") ?? externGetIdx },
    ...buildExternJoinElementToString(ctx, fctx, anyStrTypeIdx, externToStrIdx, localizedArm),
  ];
  emitStringJoinFold(ctx, fctx, repr, foldLocals, elemToStr);

  // Return the joined native string as externref for the caller.
  fctx.body.push({ op: "local.get", index: resultTmp });
  fctx.body.push({ op: "extern.convert_any" });
  return { kind: "externref" };
}

export function compileArrayJoinExtern(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
): ValType | null {
  // #3155/#4397 — standalone/WASI cannot satisfy the `__array_join_any`
  // delegation, and native-first must not select a JS semantic provider merely
  // because a JS host happens to instantiate the module. Both profiles walk
  // the externref array with the in-module provider instead.
  if (noJsHost(ctx) || ctx.targetProfile.semanticProviders === "native-first") {
    const native = compileArrayJoinExternNative(ctx, fctx, propAccess, callExpr);
    if (native !== null) return native;
    // else fall through — native string helpers unavailable, best-effort host.
  }
  const joinAnyIdx = ensureLateImport(
    ctx,
    "__array_join_any",
    [{ kind: "externref" }, { kind: "externref" }],
    [{ kind: "externref" }],
  );
  flushLateImportShifts(ctx, fctx);
  if (joinAnyIdx === undefined) return null;

  // Compile receiver, coerce to externref if needed.
  const recvType = compileExpression(ctx, fctx, propAccess.expression);
  if (recvType && recvType.kind !== "externref") {
    fctx.body.push({ op: "extern.convert_any" });
  }

  // Separator argument. Pass `undefined` (ref.null.extern) when no argument was
  // given so the runtime falls back to the spec's default `,` separator —
  // explicit `undefined` matches Array.prototype.join semantics.
  if (callExpr.arguments.length >= 1) {
    const argType = compileExpression(ctx, fctx, callExpr.arguments[0]!, { kind: "externref" });
    if (argType === null) {
      fctx.body.push({ op: "ref.null.extern" });
    } else if (argType.kind !== "externref") {
      fctx.body.push({ op: "extern.convert_any" });
    }
  } else {
    fctx.body.push({ op: "ref.null.extern" });
  }

  fctx.body.push({ op: "call", funcIdx: joinAnyIdx });
  return { kind: "externref" };
}

/**
 * True when `expr` is a call to a higher-order array method that allocates a
 * callback closure (`map`/`filter`/`flatMap`/`forEach`/`reduce`/…). The native
 * join path re-compiles its receiver via the dispatcher probe, and closure
 * registration is not idempotent, so such receivers must not route through it
 * (see #2074/#2075). Conservative: any of these method names on a call.
 */
function receiverIsClosureProducingArrayCall(expr: ts.Expression): boolean {
  if (!ts.isCallExpression(expr)) return false;
  if (!ts.isPropertyAccessExpression(expr.expression)) return false;
  const m = expr.expression.name.text;
  return (
    m === "map" ||
    m === "filter" ||
    m === "flatMap" ||
    m === "forEach" ||
    m === "reduce" ||
    m === "reduceRight" ||
    m === "find" ||
    m === "findIndex" ||
    m === "sort"
  );
}

/**
 * #2074 — native-strings (standalone / WASI) `arr.join(sep?)`.
 *
 * The default join path concatenates via the wasm:js-string `concat` builtin
 * and `number_toString`-as-externref, both unavailable (or wrong) under native
 * strings: string elements are `(ref $NativeString)` values, not externref, so
 * the host-concat loop null-derefs / illegal-casts, and the separator default
 * came from a host string-constant global. Here we build the result entirely
 * from native string helpers:
 *   - element → `(ref $AnyString)`: string elements pass through (NativeString
 *     is a subtype of AnyString); numeric elements go via `number_toString`
 *     (which returns a native string boxed as externref → convert back).
 *   - concatenation via `__str_concat`; separator materialized as a native
 *     string literal (arg, or the spec default ",").
 * Returns externref (the joined native string, converted for the caller).
 */
function compileArrayJoinNative(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
): ValType | null {
  const anyStrTypeIdx = ctx.anyStrTypeIdx;
  // #2088 — native-string representation; the fold loop + separator + empty
  // handling are shared with the host lane via `emitStringJoinFold`. This lane
  // supplies only the native repr and the element-type-specific `elemToStr`.
  const repr = nativeStringRepr(ctx);
  if (repr === undefined || anyStrTypeIdx < 0) {
    reportError(ctx, callExpr, "join requires native string helpers (__str_concat)");
    return null;
  }

  // #2105: a boolean element array stringifies as "true"/"false". The brand is
  // lost in arrDef.element, so derive boolean-ness from the receiver TS type.
  const elemIsBoolean = elemType.kind === "i32" && arrayElementIsBoolean(ctx, propAccess.expression);
  const isNumeric =
    !elemIsBoolean &&
    (elemType.kind === "f64" || elemType.kind === "i32" || elemType.kind === "i8" || elemType.kind === "i16");
  let numToStrIdx: number | undefined;
  if (isNumeric) {
    emitNativeNumberFormat(ctx, new Set(["number_toString"]));
    numToStrIdx = ctx.funcMap.get("number_toString");
    if (numToStrIdx === undefined) {
      reportError(ctx, callExpr, "join of a numeric array requires number_toString");
      return null;
    }
  }

  // #2505-family — a boxed-any (`externref`) element array stringifies each
  // element through the runtime `__extern_toString` (the same ToString
  // `String(x)`/template-literals use for an `any` value). Resolve its funcIdx
  // up front and flush the late-import shift BEFORE the fold bakes the call, so
  // the index is stable. Bail to the string-element path only if unavailable.
  let externToStrIdx: number | undefined;
  let emptyElem: { elemLocal: number; test: Instr[] } | undefined; // (#4556) step 4.b
  // (#4560) A NON-string GC-ref element — an array of object literals, whose
  // element type is a closed `$__anon_N` struct — is not a `$AnyString`, so the
  // terminal string arm's `ref.as_non_null` emitted INVALID WASM. It routes
  // through the boxed-any ToString instead; see array-join-element.ts.
  const needsRefToString =
    (elemType.kind === "ref" || elemType.kind === "ref_null") &&
    !isAnyStringSubtype(ctx, (elemType as { typeIdx: number }).typeIdx);
  // (#4655) Armed BEFORE lane J for the same reason lane J is armed before
  // `externToStrIdx`: each registration shifts the indices captured after it.
  const localizedArm = isLocalizedJoin(propAccess) ? ensureElementToLocaleStringInvoke(ctx, fctx) : undefined;
  // (#4491 lane J) Armed FIRST so `externToStrIdx` is captured after its shifts.
  const protoHoleVal = ensureJoinProtoHoleLocal(ctx, fctx);
  if (elemType.kind === "externref" || needsRefToString) {
    externToStrIdx = ensureLateImport(ctx, "__extern_toString", [{ kind: "externref" }], [{ kind: "externref" }]);
    emptyElem = joinEmptyElementTest(ctx, fctx, () =>
      ensureLateImport(ctx, "__extern_is_undefined", [{ kind: "externref" }], [{ kind: "i32" }]),
    );
    flushLateImportShifts(ctx, fctx);
    if (externToStrIdx === undefined) {
      reportError(ctx, callExpr, "join of a boxed-any array requires __extern_toString");
      return null;
    }
  }
  const vecTmp = allocLocal(fctx, `__njoin_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const dataTmp = allocLocal(fctx, `__njoin_data_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const foldLocals = allocJoinFoldLocals(fctx, repr, "njoin");
  const { lenTmp, iTmp, resultTmp, sepTmp } = foldLocals;

  // Receiver vec → length + data array.
  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.tee", index: vecTmp });
  emitReceiverNullGuard(ctx, fctx, vecTmp);
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenTmp });
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataTmp });

  // Separator: explicit arg (coerced to a native string) or the spec default
  // ",". (#4655) `toLocaleString`'s arguments are locales/options, not a
  // separator — see the module header of array-tolocalestring.ts.
  if (localizedArm === undefined && callExpr.arguments.length >= 1) {
    const argType = compileExpression(ctx, fctx, callExpr.arguments[0]!, { kind: "externref" });
    if (argType === null) {
      // void/undefined arg → default ","
      fctx.body.push(...nativeStringLiteralInstrs(ctx, ","));
    } else {
      // The native string value arrives as externref; convert to ref $AnyString.
      fctx.body.push({ op: "any.convert_extern" });
      fctx.body.push({ op: "ref.cast", typeIdx: anyStrTypeIdx });
    }
  } else {
    fctx.body.push(...nativeStringLiteralInstrs(ctx, ","));
  }
  fctx.body.push({ op: "local.set", index: sepTmp });

  // result = "" (empty native string)
  fctx.body.push(...nativeStringLiteralInstrs(ctx, ""));
  fctx.body.push({ op: "local.set", index: resultTmp });

  const getOp = elemType.kind === "i8" ? "array.get_u" : elemType.kind === "i16" ? "array.get_s" : "array.get";

  // Element → ref $AnyString.
  const elemToStr: Instr[] = [
    { op: "local.get", index: dataTmp },
    { op: "local.get", index: iTmp },
    { op: getOp, typeIdx: arrTypeIdx },
  ];
  if (elemIsBoolean) {
    // #2105: i32 element on the stack → native "true"/"false" string, then
    // cast up to ref $AnyString for the concat loop (NativeString <: AnyString).
    elemToStr.push({
      op: "if",
      blockType: { kind: "val", type: nativeStringType(ctx) },
      then: nativeStringLiteralInstrs(ctx, "true"),
      else: nativeStringLiteralInstrs(ctx, "false"),
    });
    elemToStr.push({ op: "ref.cast", typeIdx: anyStrTypeIdx });
  } else if (isNumeric && numToStrIdx !== undefined) {
    if (elemType.kind !== "f64") elemToStr.push({ op: "f64.convert_i32_s" });
    const numToStrChain: Instr[] = [
      { op: "call", funcIdx: numToStrIdx },
      // number_toString returns the native string boxed as externref.
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: anyStrTypeIdx },
    ];
    if (elemType.kind === "f64") {
      // (#4491 T8) §23.1.3.18 step 4.b for the f64 absence marker — the arm the
      // host-lane `compileArrayJoin` has had since #1998 and this native fold
      // never grew, so `[]; x[0]=0; x[3]=3` joined as "0,NaN,NaN,3".
      elemToStr.push(
        ...f64JoinSentinelArm(fctx, {
          resultType: repr.resultType,
          emptyLiteral: repr.literal(""),
          numberToString: numToStrChain,
        }),
      );
    } else {
      elemToStr.push(...numToStrChain);
    }
  } else if (elemType.kind === "externref" || needsRefToString) {
    // #2505-family + (#4560): a boxed-any element (`any[]`, `new Array(N)`
    // holes) and a non-string GC-ref element both stringify through the runtime
    // `__extern_toString` — the SAME ToString `String(a[i])` uses. Hole ∨ null ∨
    // undefined render as "" (§23.1.3.18 step 4.b). See array-join-element.ts.
    elemToStr.push(
      ...buildJoinBoxedElementToString(
        ctx,
        anyStrTypeIdx,
        emptyElem!,
        externToStrIdx!,
        needsRefToString,
        elementToLocaleStringTail(ctx, anyStrTypeIdx, localizedArm),
      ),
    );
  } else {
    // String element: a (ref null $NativeString) — non-null cast up to $AnyString.
    elemToStr.push({ op: "ref.as_non_null" });
  }

  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: iTmp });

  // #2088 — shared fold (host + native lanes route through this).
  // (#3224) Bounds-check the per-element read against the physical WasmGC
  // backing so a sparse array (logical `.length` set beyond the backing) does
  // not TRAP on the out-of-bounds `data[i]`. §23.1.3.18: an absent index joins
  // as the empty string, so a beyond-backing index yields "" — NOT a clamp: the
  // fold still iterates to the LOGICAL length, preserving the trailing empty
  // slots (`[1,2,3]; a.length=6; a.join(",")` === "1,2,3,,,"). No-op for dense
  // arrays (backing ≥ length ⇒ the guard is always true).
  // (#4491 lane J) "beyond the backing" is not "absent" — a hole INHERITS
  // `Array.prototype[k]`. Re-ask [[Get]]; see array-join-proto-hole.ts.
  const protoHoleArm = joinProtoHoleFallbackInstrs(
    ctx,
    vecTmp,
    foldLocals.iTmp,
    protoHoleVal,
    anyStrTypeIdx,
    elementToLocaleStringTail(ctx, anyStrTypeIdx, localizedArm),
  );
  const joinBoundsCheckedElemToStr: Instr[] = [
    { op: "local.get", index: foldLocals.iTmp },
    { op: "local.get", index: dataTmp },
    { op: "array.len" },
    { op: "i32.lt_s" },
    {
      op: "if",
      blockType: { kind: "val", type: repr.resultType },
      then: elemToStr,
      else: protoHoleArm ?? repr.literal(""),
    },
  ];
  emitStringJoinFold(ctx, fctx, repr, foldLocals, joinBoundsCheckedElemToStr);

  // Return the joined native string as externref for the caller.
  fctx.body.push({ op: "local.get", index: resultTmp });
  fctx.body.push({ op: "extern.convert_any" });
  return { kind: "externref" };
}

/**
 * arr.join(sep?) -> convert elements to strings and concatenate.
 * Receiver is a vec struct.
 */
function compileArrayJoin(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
): ValType | null {
  // #2074 — in native-strings mode (standalone / WASI) there is no
  // wasm:js-string `concat`; the host-concat element loop below null-derefs /
  // illegal-casts on native-string element arrays and emits imports the
  // standalone target cannot satisfy. Route through the native vec join.
  //
  // Closure-producing receiver calls are admitted here too. Their dispatcher
  // skips the non-transactional receiver probe above, so the closure and its
  // native result vec are emitted exactly once.
  if (ctx.nativeStrings && ctx.nativeStrTypeIdx >= 0) {
    return compileArrayJoinNative(ctx, fctx, propAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType);
  }

  // #1286: dispatch to compileArrayJoinExtern when the receiver evaluates to
  // externref at runtime is handled in compileArrayMethodCall via the
  // `receiverIsExternref` flag set by the probe. By the time we get here, the
  // receiver is known to be a vec struct.

  // #2105: boolean[] joins/toStrings as "true"/"false", not "1"/"0".
  const elemIsBoolean = elemType.kind === "i32" && arrayElementIsBoolean(ctx, propAccess.expression);

  // #1998: when the element type is externref/ref, each element must be
  // stringified via the `__extern_join_str` host import (undefined/null → "",
  // else ToString) before it reaches wasm:js-string `concat`. Ensure that
  // import FIRST — adding a late import shifts every defined-function /
  // import index at or above the insertion point, and `flushLateImportShifts`
  // can only repair indices already baked into instruction bodies, not the
  // raw `concatIdx`/`toStrIdx` values we capture below. Hoisting the import +
  // flush ahead of those captures keeps them correct.
  const needsExternJoinStr = elemType.kind === "externref" || elemType.kind === "ref" || elemType.kind === "ref_null";
  let joinStrIdx: number | undefined;
  if (needsExternJoinStr) {
    joinStrIdx = ensureLateImport(ctx, "__extern_join_str", [{ kind: "externref" }], [{ kind: "externref" }]);
  }

  // #1998: `number_toString` is normally registered up-front by
  // collectPrimitiveMethodImports, but only when the receiver's number-index
  // type statically resolves to number/boolean/bigint. For `any[]` receivers
  // (e.g. `([10,9] as any[]).join(",")`) the element lowers to f64 here yet the
  // import was never collected, so the f64 stringification branch below was
  // silently skipped and a raw f64 reached `concat` → "illegal cast". Ensure it
  // on demand. Hoisted above the `concatIdx` capture so the late-import index
  // shift settles before any funcIdx is read into a JS variable.
  if ((elemType.kind === "f64" || elemType.kind === "i32") && ctx.funcMap.get("number_toString") === undefined) {
    ensureLateImport(ctx, "number_toString", [{ kind: "f64" }], [{ kind: "externref" }]);
  }

  flushLateImportShifts(ctx, fctx);

  // #1998: register the empty-string constant. It backs two substitutions
  // below: (1) f64 vecs store `undefined`, array holes, and elided trailing
  // slots as the sNaN sentinel 0x7FF00000DEADC0DE (see emitDefaultValueCheck /
  // #866), which join renders as "" (§23.1.3.18 step 7.c/d) while a *genuine*
  // NaN (distinct bit pattern) still stringifies to "NaN"; (2) join/toString of
  // an empty array is "", not the initial null.
  addStringConstantGlobal(ctx, "");

  // #1997: the default separator is "," (used when join is called with no
  // argument, and always for Array.prototype.toString). It is normally
  // registered by the up-front string-constant collection, but that pass does
  // not see the implicit "," for toString / no-arg join on every receiver
  // shape. Register it on demand so the default-separator branch below emits a
  // real string global instead of falling back to `ref.null.extern` (which
  // traps "illegal cast" in wasm:js-string `concat`).
  if (callExpr.arguments.length < 1) {
    addStringConstantGlobal(ctx, ",");
  }

  const concatIdx = ctx.jsStringImports.get("concat");
  const toStrIdx = ctx.funcMap.get("number_toString");
  if (concatIdx === undefined) {
    reportError(ctx, callExpr, "join requires string support (wasm:js-string concat)");
    return null;
  }

  // #2088 — the fold loop + separator + empty-string handling are shared with
  // the native lane via `emitStringJoinFold`; this lane supplies only the
  // host-string representation and the element-type-specific `elemToStr`
  // matrix below. A bug in the shared fold regresses both lanes at once.
  const repr = hostStringRepr(ctx);
  if (repr === undefined) {
    reportError(ctx, callExpr, "join requires string support (wasm:js-string concat)");
    return null;
  }

  // #1968 — the empty-join result must be "" not a null externref (which every
  // downstream string consumer stringifies as "null"). Pre-register the ""
  // string constant *before* any body instructions so the eventual fixup of
  // module-global indices can't desync already-emitted global.gets.
  addStringConstantGlobal(ctx, "");

  const vecTmp = allocLocal(fctx, `__arr_join_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const dataTmp = allocLocal(fctx, `__arr_join_data_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const foldLocals = allocJoinFoldLocals(fctx, repr, "arr_join");
  const { lenTmp, iTmp, resultTmp, sepTmp } = foldLocals;

  // Compile receiver -> vec ref
  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.tee", index: vecTmp });
  emitReceiverNullGuard(ctx, fctx, vecTmp);

  // Get length from vec
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenTmp });

  // Get data array from vec
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataTmp });

  // separator
  if (callExpr.arguments.length >= 1) {
    compileExpression(ctx, fctx, callExpr.arguments[0]!);
  } else {
    // Default separator "," -- check if registered as string constant global
    const commaGlobalIdx = ctx.stringGlobalMap.get(",");
    if (commaGlobalIdx !== undefined) {
      fctx.body.push({ op: "global.get", index: commaGlobalIdx });
    } else {
      fctx.body.push({ op: "ref.null.extern" });
    }
  }
  fctx.body.push({ op: "local.set", index: sepTmp });

  // result starts as "" (the empty-array join result, #1968) — not null, which
  // would stringify as "null". A non-empty array overwrites this on iteration 0.
  compileStringLiteral(ctx, fctx, "");
  fctx.body.push({ op: "local.set", index: resultTmp });

  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: iTmp });

  const getOp = elemType.kind === "i8" ? "array.get_u" : elemType.kind === "i16" ? "array.get_s" : "array.get";

  // Build element-to-string instructions (use dataTmp instead of arrTmp)
  const elemToStr: Instr[] = [
    { op: "local.get", index: dataTmp },
    { op: "local.get", index: iTmp },
    { op: getOp, typeIdx: arrTypeIdx },
  ];
  if (elemType.kind === "f64" && toStrIdx !== undefined) {
    // #1998: substitute "" for the undefined/hole sNaN sentinel; otherwise
    // ToString the number (so a genuine NaN still renders "NaN").
    const elemF64Tmp = allocLocal(fctx, `__arr_join_elem_${fctx.locals.length}`, { kind: "f64" });
    elemToStr.push({ op: "local.tee", index: elemF64Tmp });
    elemToStr.push({ op: "i64.reinterpret_f64" });
    elemToStr.push({ op: "i64.const", value: 0x7ff00000deadc0den });
    elemToStr.push({ op: "i64.eq" });
    elemToStr.push({
      op: "if",
      blockType: { kind: "val", type: { kind: "externref" } },
      then: stringConstantExternrefInstrs(ctx, ""),
      else: [
        { op: "local.get", index: elemF64Tmp },
        { op: "call", funcIdx: toStrIdx },
      ],
    });
  } else if (elemType.kind === "i32" && elemIsBoolean) {
    // #2105: a boolean element array stringifies as "true"/"false", not the
    // numeric "1"/"0" produced by number_toString. The boolean brand is lost
    // in arrDef.element (structural array dedup), so derive boolean-ness from
    // the receiver's TS element type. Select the "true"/"false" string-constant
    // global from the i32 element on the stack (JS-host externref form).
    addStringConstantGlobal(ctx, "true");
    addStringConstantGlobal(ctx, "false");
    elemToStr.push({
      op: "if",
      blockType: { kind: "val", type: { kind: "externref" } },
      then: [{ op: "global.get", index: ctx.stringGlobalMap.get("true")! }],
      else: [{ op: "global.get", index: ctx.stringGlobalMap.get("false")! }],
    });
  } else if (elemType.kind === "i32" && toStrIdx !== undefined) {
    elemToStr.push({ op: "f64.convert_i32_s" });
    elemToStr.push({ op: "call", funcIdx: toStrIdx });
  } else if (needsExternJoinStr && joinStrIdx !== undefined) {
    // #1998: any/object/boxed elements arrive as a raw externref. Feeding that
    // straight into wasm:js-string `concat` traps "illegal cast" because the
    // builtin requires string operands. Route each element through
    // `__extern_join_str` (ensured above), which applies Array.prototype.join's
    // spec rule (§23.1.3.18 step 7.c/d): `undefined`/`null` → "", else ToString.
    if (elemType.kind !== "externref") {
      // A WasmGC struct ref must be re-expressed as externref for the import.
      elemToStr.push({ op: "extern.convert_any" });
    }
    // (#2001 S1) A `$Hole` element renders as "" (an absent index joins like
    // undefined). After S1 a literal elision stores the `$Hole` sentinel, so
    // without this test `__extern_join_str($Hole)` would ToString the sentinel
    // struct (NOT undefined/null) to garbage. Only externref elements can hold
    // the sentinel; gated on `usesArrayHoles` so hole-free joins are unchanged.
    const holeTest = elemType.kind === "externref" && ctx.usesArrayHoles ? holeTestInstrs(ctx) : [];
    if (holeTest.length > 0) {
      const elemExternTmp = allocTempLocal(fctx, { kind: "externref" });
      elemToStr.push({ op: "local.tee", index: elemExternTmp });
      elemToStr.push(...holeTest);
      elemToStr.push({
        op: "if",
        blockType: { kind: "val", type: { kind: "externref" } },
        then: stringConstantExternrefInstrs(ctx, ""),
        else: [
          { op: "local.get", index: elemExternTmp },
          { op: "call", funcIdx: joinStrIdx },
        ],
      });
    } else {
      elemToStr.push({ op: "call", funcIdx: joinStrIdx });
    }
  }

  // #2088 — shared fold (host + native lanes route through this).
  // (#3224) Bounds-check the per-element read against the physical WasmGC
  // backing so a sparse array (logical `.length` set beyond the backing) does
  // not TRAP on the out-of-bounds `data[i]`. §23.1.3.18: an absent index joins
  // as the empty string, so a beyond-backing index yields "" — NOT a clamp: the
  // fold still iterates to the LOGICAL length, preserving the trailing empty
  // slots (`[1,2,3]; a.length=6; a.join(",")` === "1,2,3,,,"). No-op for dense
  // arrays (backing ≥ length ⇒ the guard is always true).
  const joinBoundsCheckedElemToStr: Instr[] = [
    { op: "local.get", index: foldLocals.iTmp },
    { op: "local.get", index: dataTmp },
    { op: "array.len" },
    { op: "i32.lt_s" },
    {
      op: "if",
      blockType: { kind: "val", type: repr.resultType },
      then: elemToStr,
      else: repr.literal(""),
    },
  ];
  emitStringJoinFold(ctx, fctx, repr, foldLocals, joinBoundsCheckedElemToStr);

  // An empty array leaves `resultTmp` as the initial null. join/toString of `[]`
  // is the empty String "", not null — substitute it so the result is a real
  // string (also keeps a null from ever reaching a caller that concatenates it).
  fctx.body.push({ op: "local.get", index: resultTmp });
  fctx.body.push({ op: "ref.is_null" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "externref" } },
    then: stringConstantExternrefInstrs(ctx, ""),
    else: [{ op: "local.get", index: resultTmp }],
  });
  return { kind: "externref" };
}

/**
 * arr.splice(start, deleteCount?) -> in-place shift, returns new vec with deleted elements.
 *
 * #1359 Slice D (deleteCount=undefined): verified spec-correct in this
 * function on 2026-05-08:
 *   - 0-arg splice → empty array, no mutation ✓ §23.1.3.30 step 5
 *   - 1-arg splice(start) → delCount = len - actualStart ✓ §23.1.3.30 step 11.b
 *   - 2-arg splice(start, undefined) → compiles undefined as f64 NaN →
 *     `i32.trunc_sat_f64_s(NaN) = 0` ✓ matches ToInteger(undefined) = 0
 *
 * The architect's reference test `splice/S15.4.4.12_A6.1_T2.js` actually
 * tests TypeError-throw when `length` is non-writable, which needs
 * Object.defineProperty + writable-attr fidelity (#1334), not a fix
 * here. The 25 splice `assertion_fail` count in the issue's table
 * needs re-bucketing before any further splice fix is attempted.
 */
function compileArraySplice(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  _elemType: ValType,
): ValType | null {
  // 0-arg splice: no mutation, return empty array
  if (callExpr.arguments.length === 0) {
    // Still need to evaluate receiver for side effects. (#5145) It is also the
    // ArraySpeciesCreate receiver: `splice/create-species-non-ctor.js` and its
    // siblings call `a.splice()` with NO arguments and still expect the §23.1.3.29
    // step-11 `ArraySpeciesCreate(O, 0)` to run (and throw).
    const recvType = compileExpression(ctx, fctx, propAccess.expression);
    const zeroArgSpeciesDeps = prepareArraySpeciesDeps(ctx, fctx);
    let zeroArgSpeciesLocal: number | undefined;
    if (zeroArgSpeciesDeps !== undefined && (recvType?.kind === "ref" || recvType?.kind === "ref_null")) {
      const recvTmp = allocLocal(fctx, `__arr_spl0_recv_${fctx.locals.length}`, recvType);
      fctx.body.push({ op: "local.set", index: recvTmp });
      zeroArgSpeciesLocal = emitArraySpeciesCreate(
        ctx,
        fctx,
        zeroArgSpeciesDeps,
        [{ op: "local.get", index: recvTmp }, { op: "extern.convert_any" }],
        [{ op: "f64.const", value: 0 }],
      );
    } else {
      fctx.body.push({ op: "drop" });
    }
    // Return empty vec struct: { 0, array.new_default(0) }
    fctx.body.push({ op: "i32.const", value: 0 });
    fctx.body.push({ op: "i32.const", value: 0 });
    fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
    fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
    if (zeroArgSpeciesDeps !== undefined && zeroArgSpeciesLocal !== undefined) {
      return emitArraySpeciesResultSwap(ctx, fctx, zeroArgSpeciesDeps, zeroArgSpeciesLocal, {
        kind: "ref_null",
        typeIdx: vecTypeIdx,
      });
    }
    return { kind: "ref_null", typeIdx: vecTypeIdx };
  }

  const vecTmp = allocLocal(fctx, `__arr_spl_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const dataTmp = allocLocal(fctx, `__arr_spl_data_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const delData = allocLocal(fctx, `__arr_spl_deld_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const lenTmp = allocLocal(fctx, `__arr_spl_len_${fctx.locals.length}`, { kind: "i32" });
  const startTmp = allocLocal(fctx, `__arr_spl_s_${fctx.locals.length}`, { kind: "i32" });
  const delCountTmp = allocLocal(fctx, `__arr_spl_dc_${fctx.locals.length}`, { kind: "i32" });
  const newLenTmp = allocLocal(fctx, `__arr_spl_nl_${fctx.locals.length}`, { kind: "i32" });
  const tailCountTmp = allocLocal(fctx, `__arr_spl_tc_${fctx.locals.length}`, { kind: "i32" });
  const tailStartTmp = allocLocal(fctx, `__arr_spl_ts_${fctx.locals.length}`, { kind: "i32" });

  // #1815 — items to insert at `start` (arguments[2..]). When present, the
  // backing array must be rebuilt (it may need to grow), so we cannot use the
  // in-place tail-shift path that only works when newLen <= len.
  const insertCount = Math.max(0, callExpr.arguments.length - 2);
  const newData =
    insertCount > 0
      ? allocLocal(fctx, `__arr_spl_ndata_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx })
      : -1;
  const writeTmp = insertCount > 0 ? allocLocal(fctx, `__arr_spl_w_${fctx.locals.length}`, { kind: "i32" }) : -1;

  // Compile receiver -> vec ref
  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.tee", index: vecTmp });
  emitReceiverNullGuard(ctx, fctx, vecTmp);

  // Get length from vec
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenTmp });

  // Get data array from vec
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataTmp });

  // start arg -- clamp negative indices
  compileExpression(ctx, fctx, callExpr.arguments[0]!, { kind: "f64" });
  fctx.body.push({ op: "i32.trunc_sat_f64_s" });
  fctx.body.push({ op: "local.set", index: startTmp });
  emitClampIndex(fctx, startTmp, lenTmp);

  // deleteCount (default: len - start) -- clamp >= 0 and to remaining len
  if (callExpr.arguments.length >= 2) {
    compileExpression(ctx, fctx, callExpr.arguments[1]!, { kind: "f64" });
    fctx.body.push({ op: "i32.trunc_sat_f64_s" });
  } else {
    fctx.body.push({ op: "local.get", index: lenTmp });
    fctx.body.push({ op: "local.get", index: startTmp });
    fctx.body.push({ op: "i32.sub" });
  }
  fctx.body.push({ op: "local.set", index: delCountTmp });
  emitClampNonNeg(fctx, delCountTmp);
  // Clamp delCount to not exceed remaining elements: min(delCount, len - start)
  fctx.body.push({ op: "local.get", index: lenTmp });
  fctx.body.push({ op: "local.get", index: startTmp });
  fctx.body.push({ op: "i32.sub" });
  fctx.body.push({ op: "local.set", index: tailCountTmp }); // reuse as temp
  fctx.body.push({ op: "local.get", index: delCountTmp });
  fctx.body.push({ op: "local.get", index: tailCountTmp });
  fctx.body.push({ op: "i32.gt_s" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [
      { op: "local.get", index: tailCountTmp },
      { op: "local.set", index: delCountTmp },
    ],
  });
  emitClampNonNeg(fctx, delCountTmp);

  // (#5145) §23.1.3.29 step 11 — `A = ArraySpeciesCreate(O, actualDeleteCount)`,
  // before any element is moved.
  const speciesDeps = prepareArraySpeciesDeps(ctx, fctx);
  const speciesLocal =
    speciesDeps === undefined
      ? undefined
      : emitArraySpeciesCreate(
          ctx,
          fctx,
          speciesDeps,
          [{ op: "local.get", index: vecTmp }, { op: "extern.convert_any" }],
          [{ op: "local.get", index: delCountTmp }, { op: "f64.convert_i32_s" }],
        );

  // Create deleted elements backing array and copy
  fctx.body.push({ op: "local.get", index: delCountTmp });
  fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
  fctx.body.push({ op: "local.set", index: delData });

  // array.copy delData[0..delCount] = data[start..start+delCount] — (#3201)
  // clamp the copy count to the physical backing so a sparse receiver (logical
  // `.length` > array.len(data)) doesn't read past the backing (which traps).
  // delData keeps its delCount slots; the beyond-backing tail stays a hole.
  emitBackingClampedArrayCopy(ctx, fctx, arrTypeIdx, delData, null, dataTmp, startTmp, delCountTmp);

  // tailStart = start + delCount
  fctx.body.push({ op: "local.get", index: startTmp });
  fctx.body.push({ op: "local.get", index: delCountTmp });
  fctx.body.push({ op: "i32.add" });
  fctx.body.push({ op: "local.set", index: tailStartTmp });

  // tailCount = max(0, len - tailStart)
  fctx.body.push({ op: "local.get", index: lenTmp });
  fctx.body.push({ op: "local.get", index: tailStartTmp });
  fctx.body.push({ op: "i32.sub" });
  fctx.body.push({ op: "local.set", index: tailCountTmp });
  emitClampNonNeg(fctx, tailCountTmp);

  if (insertCount > 0) {
    // #1815 — insertion path: rebuild the backing array in place.
    // newLen = len - delCount + insertCount  (= start + insertCount + tailCount)
    fctx.body.push({ op: "local.get", index: startTmp });
    fctx.body.push({ op: "i32.const", value: insertCount });
    fctx.body.push({ op: "i32.add" });
    fctx.body.push({ op: "local.get", index: tailCountTmp });
    fctx.body.push({ op: "i32.add" });
    fctx.body.push({ op: "local.set", index: newLenTmp });

    // newData = array.new_default(newLen)
    fctx.body.push({ op: "local.get", index: newLenTmp });
    fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
    fctx.body.push({ op: "local.set", index: newData });

    // Part 1: head — newData[0..start] = data[0..start] — (#3201) clamp to backing.
    emitBackingClampedArrayCopy(ctx, fctx, arrTypeIdx, newData, null, dataTmp, null, startTmp);

    // Part 2: items — newData[start..start+insertCount] = arguments[2..]
    fctx.body.push({ op: "local.get", index: startTmp });
    fctx.body.push({ op: "local.set", index: writeTmp });
    for (let i = 0; i < insertCount; i++) {
      fctx.body.push({ op: "local.get", index: newData });
      fctx.body.push({ op: "local.get", index: writeTmp });
      compileExpression(ctx, fctx, callExpr.arguments[2 + i]!, _elemType);
      fctx.body.push({ op: "array.set", typeIdx: arrTypeIdx });
      if (i < insertCount - 1) {
        fctx.body.push({ op: "local.get", index: writeTmp });
        fctx.body.push({ op: "i32.const", value: 1 });
        fctx.body.push({ op: "i32.add" });
        fctx.body.push({ op: "local.set", index: writeTmp });
      }
    }

    // Part 3: tail — newData[start+insertCount..] = data[tailStart..tailStart+tailCount]
    fctx.body.push({ op: "local.get", index: startTmp });
    fctx.body.push({ op: "i32.const", value: insertCount });
    fctx.body.push({ op: "i32.add" });
    fctx.body.push({ op: "local.set", index: writeTmp });
    // (#3201) clamp the tail read to the backing (+ guard) so a sparse receiver doesn't trap.
    emitBackingClampedArrayCopy(ctx, fctx, arrTypeIdx, newData, writeTmp, dataTmp, tailStartTmp, tailCountTmp);

    // Write new backing array + length back into the same vec struct (in place)
    fctx.body.push({ op: "local.get", index: vecTmp });
    fctx.body.push({ op: "local.get", index: newData });
    fctx.body.push({ op: "ref.as_non_null" });
    fctx.body.push({ op: "struct.set", typeIdx: vecTypeIdx, fieldIdx: 1 });
    fctx.body.push({ op: "local.get", index: vecTmp });
    fctx.body.push({ op: "local.get", index: newLenTmp });
    fctx.body.push({ op: "struct.set", typeIdx: vecTypeIdx, fieldIdx: 0 });
  } else {
    // No insertion: shift tail left in-place (newLen <= len, capacity suffices).
    // array.copy data[start..start+tailCount] = data[tailStart..tailStart+tailCount]
    // (#3201) clamp the tail read to the backing (+ guard) so a sparse receiver
    // (logical `.length` > array.len(data)) doesn't array.copy past the backing.
    emitBackingClampedArrayCopy(ctx, fctx, arrTypeIdx, dataTmp, startTmp, dataTmp, tailStartTmp, tailCountTmp);

    // newLen = len - delCount
    fctx.body.push({ op: "local.get", index: lenTmp });
    fctx.body.push({ op: "local.get", index: delCountTmp });
    fctx.body.push({ op: "i32.sub" });
    fctx.body.push({ op: "local.set", index: newLenTmp });

    // Update vec length
    fctx.body.push({ op: "local.get", index: vecTmp });
    fctx.body.push({ op: "local.get", index: newLenTmp });
    fctx.body.push({ op: "struct.set", typeIdx: vecTypeIdx, fieldIdx: 0 });
  }

  // Return new vec with deleted elements: { delCount, delData }
  fctx.body.push({ op: "local.get", index: delCountTmp });
  fctx.body.push({ op: "local.get", index: delData });
  fctx.body.push({ op: "ref.as_non_null" });
  fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
  if (speciesDeps !== undefined && speciesLocal !== undefined) {
    return emitArraySpeciesResultSwap(ctx, fctx, speciesDeps, speciesLocal, {
      kind: "ref_null",
      typeIdx: vecTypeIdx,
    });
  }
  return { kind: "ref_null", typeIdx: vecTypeIdx };
}

// ── Functional array methods (filter, map, reduce, forEach, find, findIndex, some, every) ──
// Shared helpers to reduce duplication across callback-based array methods.

/** Result of setting up a callback for an array method (closure or host bridge). */
interface ArrayCallbackSetup {
  closureInfo?: ClosureInfo;
  closureTypeIdx?: number;
  closureTmp?: number;
  callBridgeIdx?: number;
  cbTmp?: number;
  /** Argument carrier expected by the host callback bridge. */
  bridgeArgType?: ValType;
  /** Result carrier produced by the host callback bridge. */
  bridgeResultType?: ValType;
  /**
   * #2152 — externref local holding the `thisArg` to bind as the callback's
   * `this` (spec §23.1.3.* `Call(callbackfn, thisArg, …)`). Undefined when the
   * method takes no thisArg (reduce/reduceRight), none was passed, or the
   * callback is an arrow function (arrows are lexically `this`-bound, so the
   * thisArg is ignored). When set, `buildClosureCallInstrs` installs it into the
   * `__current_this` module global (save/restore) around the `call_ref`, where
   * the callback body's `this` reads it (#1636-S1 / #1702).
   */
  thisArgTmp?: number;
  /**
   * #2152 — externref save slot for the previous `__current_this` value, so the
   * global can be restored after each callback `call_ref` (nesting safety:
   * nested HOFs / re-entrant dispatch must not leak a stale receiver). Paired
   * with `thisArgTmp` (set iff `thisArgTmp` is set).
   */
  prevThisTmp?: number;
}

/**
 * #2152 — Compile the optional `thisArg` argument of an array HOF method into an
 * externref local so it can be installed as the callback's `this` around the
 * `call_ref`. Returns the local index, or undefined when no thisArg should be
 * forwarded:
 *   - the method has no thisArg slot (`thisArgIndex` undefined — reduce family),
 *   - no thisArg argument is present,
 *   - the callback is an arrow function (lexical `this`; thisArg ignored).
 * Per ECMA-262 the thisArg is evaluated as `arguments[thisArgIndex]`, AFTER the
 * callback (`arguments[0]`), which matches the call order here (callback is
 * compiled by `setupArrayCallback` before this runs).
 */
function compileThisArg(
  ctx: CodegenContext,
  fctx: FunctionContext,
  callExpr: ts.CallExpression,
  tag: string,
  thisArgIndex: number | undefined,
): { thisArgTmp: number; prevThisTmp: number } | undefined {
  if (thisArgIndex === undefined) return undefined;
  const cbArg = callExpr.arguments[0];
  // Arrow callbacks are lexically `this`-bound — the thisArg MUST be ignored.
  if (cbArg && ts.isArrowFunction(cbArg)) return undefined;
  const thisArgExpr = callExpr.arguments[thisArgIndex];
  if (!thisArgExpr) return undefined;

  // Ensure the __current_this global exists so buildClosureCallInstrs can install.
  ensureCurrentThisGlobal(ctx);
  const thisArgTmp = allocLocal(fctx, `__arr_${tag}_this_${fctx.locals.length}`, { kind: "externref" });
  const prevThisTmp = allocLocal(fctx, `__arr_${tag}_prevthis_${fctx.locals.length}`, { kind: "externref" });
  const tArgType = compileExpression(ctx, fctx, thisArgExpr);
  if (tArgType && tArgType.kind !== "externref") {
    coerceType(ctx, fctx, tArgType, { kind: "externref" });
  } else if (!tArgType) {
    // null result — treat as undefined receiver.
    emitUndefined(ctx, fctx);
  }
  fctx.body.push({ op: "local.set", index: thisArgTmp });
  return { thisArgTmp, prevThisTmp };
}

/**
 * (#3015) Resolve the canonical funcref-wrapper closure for a DYNAMIC
 * function-typed callback value that compiled to an opaque `externref` — i.e. a
 * function PARAMETER (`function run(cb){ return arr.some(cb); }`), the one
 * callback shape that still routed through the `__call_1_*` / `__call_2_*` host
 * bridge. In standalone (host-free) mode that import makes the module
 * non-instantiable, so those tests never ran.
 *
 * The value IS a wasm closure struct at runtime (the caller passed an arrow /
 * function value), so we recover a native `call_ref` by resolving the
 * callback SIGNATURE's canonical wrapper via `getOrCreateFuncRefWrapperTypes` —
 * the SAME cache-keyed wrapper the arrow value-site registers, so the runtime
 * closure struct (a subtype of the wrapper root) casts and calls cleanly. We
 * return the `ClosureInfo` plus the lifted self carrier (the wrapper root) that
 * the externref is cast to.
 *
 * Returns `undefined` (→ host-bridge fallback, unchanged) when the callback has
 * no single resolvable call signature.
 */
function resolveDynamicCallbackClosure(
  ctx: CodegenContext,
  cbArg: ts.Expression,
): { closureInfo: ClosureInfo; selfStructTypeIdx: number } | undefined {
  // oracle-ratchet-allow (#3015): the wrapper cache key is a wasm-lowering
  // ValType question (`resolveWasmType`), deliberately ABOVE `ctx.oracle`. This
  // mirrors `compileArrowAsClosure`'s `computeClosureWrapperSig` lowering so the
  // key MATCHES the arrow value-site's — they share the wrapper struct + func
  // type, which is exactly what makes the runtime `ref.cast` + `call_ref` valid.
  const loweredSig =
    ts.isIdentifier(cbArg) && ctx.funcMap.get(cbArg.text) !== undefined
      ? getFuncSignature(ctx, ctx.funcMap.get(cbArg.text)!)
      : undefined;
  const cbType = ctx.checker.getTypeAtLocation(cbArg);
  const sigs = cbType.getCallSignatures();
  if (loweredSig === undefined && sigs.length !== 1) return undefined;
  const paramValTypes: ValType[] = loweredSig
    ? loweredSig.params.map((param) => ({ ...param }))
    : sigs[0]!.parameters.map((p) =>
        resolveWasmType(
          ctx,
          ctx.checker.getTypeOfSymbolAtLocation(p, p.valueDeclaration ?? p.declarations?.[0] ?? cbArg),
        ),
      );
  const results: ValType[] = loweredSig
    ? loweredSig.results.map((result) => ({ ...result }))
    : (() => {
        const retTsType = ctx.checker.getReturnTypeOfSignature(sigs[0]!);
        return isVoidType(retTsType) || (retTsType.flags & ts.TypeFlags.Never) !== 0
          ? []
          : [resolveWasmTypeForClosureReturn(ctx, retTsType)];
      })();
  const wrapper = getOrCreateFuncRefWrapperTypes(ctx, paramValTypes, results);
  if (!wrapper) return undefined;
  const selfStructTypeIdx = getClosureFuncSelfTypeIdx(ctx, wrapper.liftedFuncTypeIdx) ?? wrapper.structTypeIdx;
  return { closureInfo: wrapper.closureInfo, selfStructTypeIdx };
}

/**
 * Compile the callback argument and set up either a closure (call_ref) path
 * or a host bridge fallback. Returns null if setup fails (error pushed).
 *
 * `thisArgIndex` (#2152): the argument position of the spec `thisArg` for this
 * method (1 for filter / map / forEach / find / findIndex / findLast /
 * findLastIndex / some / every), or undefined for methods with no thisArg
 * (reduce / reduceRight). When present and the callback is not an arrow, the
 * thisArg is compiled and threaded so the callback's `this` binds to it.
 */
function setupArrayCallback(
  ctx: CodegenContext,
  fctx: FunctionContext,
  callExpr: ts.CallExpression,
  methodName: string,
  tag: string,
  bridgeName?: string,
  thisArgIndex?: number,
): ArrayCallbackSetup | null {
  const cbArg = callExpr.arguments[0]!;
  const hoistedCallback =
    ts.isIdentifier(cbArg) && fctx.hoistedFunctionValueBindings?.has(cbArg.text)
      ? (() => {
          const funcIdx = ctx.funcMap.get(cbArg.text);
          return funcIdx === undefined ? undefined : emitFuncRefAsClosure(ctx, fctx, cbArg.text, funcIdx);
        })()
      : undefined;
  const cbResult =
    hoistedCallback ??
    (ts.isArrowFunction(cbArg) || ts.isFunctionExpression(cbArg)
      ? compileArrowAsClosure(ctx, fctx, cbArg)
      : compileExpression(ctx, fctx, cbArg));

  let closureInfo: ClosureInfo | undefined;
  let closureTypeIdx: number | undefined;
  let closureTmp: number | undefined;

  if (cbResult && (cbResult.kind === "ref" || cbResult.kind === "ref_null")) {
    closureTypeIdx = (cbResult as { typeIdx: number }).typeIdx;
    closureInfo = ctx.closureInfoByTypeIdx.get(closureTypeIdx);
    if (closureInfo) {
      closureTmp = allocLocal(fctx, `__arr_${tag}_clcb_${fctx.locals.length}`, cbResult);
      fctx.body.push({ op: "local.set", index: closureTmp });
    }
  } else if (ctx.standalone && cbResult && cbResult.kind === "externref") {
    // (#3015) Standalone: a dynamic function-typed callback value (a function
    // PARAMETER, e.g. `arr.some(cb)`) arrives as an opaque externref and would
    // otherwise route through the `__call_1_*`/`__call_2_*` host bridge — a
    // host import that is not instantiable host-free. Recover a native
    // `call_ref` via the callback signature's canonical funcref wrapper. Host
    // mode is untouched (this branch is standalone-gated) and keeps the bridge
    // as its fast path per the dual-mode principle.
    const dyn = resolveDynamicCallbackClosure(ctx, cbArg);
    if (dyn) {
      closureInfo = dyn.closureInfo;
      closureTypeIdx = dyn.selfStructTypeIdx;
      // The externref callback value is on the stack: convert it to the wrapper
      // self carrier and store a NON-NULL closure ref. The native invocation
      // path (`buildClosureCallInstrs` / reduce) pushes `closureTmp` as the
      // `call_ref` self argument, whose param type is `(ref root)` — non-null,
      // matching the arrow branch's `(ref …)` `closureTmp`.
      fctx.body.push({ op: "any.convert_extern" });
      emitRuntimeEvalCarrierUnwrapAny(ctx, fctx);
      emitGuardedRefCast(fctx, dyn.selfStructTypeIdx);
      fctx.body.push({ op: "ref.as_non_null" });
      closureTmp = allocLocal(fctx, `__arr_${tag}_dyncb_${fctx.locals.length}`, {
        kind: "ref",
        typeIdx: dyn.selfStructTypeIdx,
      });
      fctx.body.push({ op: "local.set", index: closureTmp });
    }
  }

  let callBridgeIdx: number | undefined;
  let cbTmp: number | undefined;
  let bridgeArgType: ValType | undefined;
  let bridgeResultType: ValType | undefined;
  if (!closureInfo) {
    const bridge = bridgeName ?? (ctx.fast ? "__call_1_i32" : "__call_1_f64");
    const referenceBridge = bridge === "__call_dyn_1";
    if (referenceBridge) {
      const externref: ValType = { kind: "externref" };
      bridgeArgType = externref;
      bridgeResultType = externref;
      callBridgeIdx = ctx.funcMap.get(bridge);
    } else {
      bridgeArgType = ctx.fast ? { kind: "i32" } : { kind: "f64" };
      bridgeResultType = bridgeArgType;
      callBridgeIdx = ctx.funcMap.get(bridge);
    }
    if (callBridgeIdx === undefined) {
      reportError(ctx, callExpr, `Missing ${bridge} import for ${methodName}`);
      return null;
    }
    if (referenceBridge && cbResult && cbResult.kind !== "externref") {
      coerceType(ctx, fctx, cbResult, { kind: "externref" });
    }
    cbTmp = allocLocal(fctx, `__arr_${tag}_cb_${fctx.locals.length}`, { kind: "externref" });
    fctx.body.push({ op: "local.set", index: cbTmp });
  }

  // #2152 — compile the optional thisArg AFTER the callback (spec arg order).
  const thisArgSlots = compileThisArg(ctx, fctx, callExpr, tag, thisArgIndex);

  return {
    closureInfo,
    closureTypeIdx,
    closureTmp,
    callBridgeIdx,
    cbTmp,
    bridgeArgType,
    bridgeResultType,
    thisArgTmp: thisArgSlots?.thisArgTmp,
    prevThisTmp: thisArgSlots?.prevThisTmp,
  };
}

/** Common locals for array iteration loops. */
interface ArrayLoopLocals {
  vecTmp: number;
  dataTmp: number;
  /**
   * (#3215) The loop bound — CLAMPED to the physical backing
   * (`min(field0, array.len(data))`) so a sparse receiver (logical `.length`
   * beyond the backing) never OOB-traps on `data[i]`. Equal to the logical
   * length for dense arrays.
   */
  lenTmp: number;
  /**
   * (#3215) The UNCLAMPED logical `.length` (vec field 0). Use this — not
   * `lenTmp` — for result-object sizing that must be the logical length
   * (map's result, §23.1.3.19). Equal to `lenTmp` for dense arrays.
   */
  logicalLenTmp: number;
  iTmp: number;
  getOp: "array.get_u" | "array.get_s" | "array.get";
}

/** Substitute closure parameter reads with the HOF loop's concrete operands. */
function instantiateInlineClosureBody(
  closureInfo: ClosureInfo,
  parameterLoads: readonly (readonly Instr[])[],
): Instr[] | undefined {
  if (!closureInfo.inlineBody || closureInfo.needsCallSiteArity !== false) return undefined;
  const body: Instr[] = [];
  for (const instr of closureInfo.inlineBody) {
    if (instr.op === "local.get") {
      const replacement = parameterLoads[(instr as { index: number }).index - 1];
      if (!replacement) return undefined;
      body.push(...replacement.map((item) => ({ ...item })));
    } else {
      body.push({ ...instr });
    }
  }
  return body;
}

/**
 * Compile receiver, extract vec/data/len, alloc loop locals, set i = 0.
 * The caller (compileArrayMethodCall) has already resolved the correct
 * vec/arr/elem types via probe-compile (#826).
 */
function setupArrayLoop(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
  tag: string,
  receiverIsExternref = false,
): ArrayLoopLocals {
  // (#2001 S1) When the per-iteration callback value-mapping (`$Hole →
  // undefined`, built as detached instrs in `buildClosureCallInstrs`) may run,
  // pre-register + flush `__get_undefined` HERE, while we still own `fctx.body`.
  // `holeToUndefinedInstrs` calls `emitUndefined`, whose late-import flush would
  // otherwise fire mid-detached-build and shift the already-captured closure
  // funcIdx out from under the `call_ref` (→ null-deref). Pre-ensuring makes
  // the later `emitUndefined` a no-op lookup. Gated like the mapping itself.
  if (ctx.usesArrayHoles && elemType.kind === "externref") {
    ensureGetUndefined(ctx);
    flushLateImportShifts(ctx, fctx);
  }
  const receiverType = compileExpression(
    ctx,
    fctx,
    propAccess.expression,
    receiverIsExternref ? { kind: "externref" } : undefined,
  );

  // (#3996) A dynamically typed producer such as `Object.keys(any)` returns a
  // real JavaScript array (externref) in the JS-host lane. The callback HOFs
  // operate on the compiler's canonical WasmGC vec representation; casting
  // that host array to a vec traps before the first callback. Materialize the
  // cross-representation receiver once through the same externref→vec path
  // used by assignments and destructuring.
  if (receiverIsExternref && receiverType?.kind === "externref") {
    const externTmp = allocLocal(fctx, `__arr_${tag}_extern_${fctx.locals.length}`, { kind: "externref" });
    fctx.body.push({ op: "local.set", index: externTmp });
    fctx.body.push(...buildVecFromExternref(ctx, fctx, externTmp, vecTypeIdx, { arrTypeIdx, elemType }));
  }

  const vecTmp = allocLocal(fctx, `__arr_${tag}_vec_${fctx.locals.length}`, {
    kind: "ref_null",
    typeIdx: vecTypeIdx,
  });
  const dataTmp = allocLocal(fctx, `__arr_${tag}_data_${fctx.locals.length}`, {
    kind: "ref_null",
    typeIdx: arrTypeIdx,
  });
  const lenTmp = allocLocal(fctx, `__arr_${tag}_len_${fctx.locals.length}`, { kind: "i32" });
  const iTmp = allocLocal(fctx, `__arr_${tag}_i_${fctx.locals.length}`, { kind: "i32" });

  fctx.body.push({ op: "local.tee", index: vecTmp });
  emitReceiverNullGuard(ctx, fctx, vecTmp);
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenTmp });
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataTmp });

  // (#3215) Clamp the shared loop bound to the physical WasmGC backing so a
  // sparse receiver (logical `.length` set beyond the backing) never TRAPS on
  // the out-of-bounds `array.get data[i]` in the HOF loop. Per spec these HOFs
  // use HasProperty (holes are SKIPPED), so iterating only the physical defined
  // prefix — and skipping the beyond-backing holes — is spec-correct. The
  // UNCLAMPED logical length is preserved in `logicalLenTmp` for consumers that
  // must size a result by the logical length (map, §23.1.3.19). Dense arrays
  // keep `lenTmp` unchanged (backing capacity ≥ length ⇒ min is the length ⇒
  // runtime no-op). This is the HOF analog of the #2980 sort/includes and #2968
  // indexOf backing-clamps.
  const logicalLenTmp = allocLocal(fctx, `__arr_${tag}_loglen_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "local.get", index: lenTmp });
  fctx.body.push({ op: "local.set", index: logicalLenTmp });
  emitBackingLenClamp(fctx, lenTmp, dataTmp);

  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: iTmp });

  const getOp = elemType.kind === "i8" ? "array.get_u" : elemType.kind === "i16" ? "array.get_s" : "array.get";
  return { vecTmp, dataTmp, lenTmp, logicalLenTmp, iTmp, getOp };
}

/**
 * Build closure call_ref instructions for a 1-arg callback (element, [index, [array]]).
 * The element source can be either an elemTmp local or inline data[i].
 */
function buildClosureCallInstrs(
  ctx: CodegenContext,
  fctx: FunctionContext,
  setup: ArrayCallbackSetup,
  elemType: ValType,
  vecTypeIdx: number,
  arrTypeIdx: number,
  loop: ArrayLoopLocals,
  elemSource: { kind: "local"; index: number } | { kind: "inline" },
): Instr[] {
  const { closureInfo, closureTypeIdx, closureTmp } = setup;
  if (!closureInfo || closureTypeIdx === undefined || closureTmp === undefined) return [];
  const numParams = closureInfo.paramTypes.length;
  const elemCoerce = closureInfo.paramTypes[0] ? coercionInstrs(ctx, elemType, closureInfo.paramTypes[0], fctx) : [];

  // #820l — array-method callbacks are invoked at spec arity 3
  // (value, index, array). The callee's `arguments` object should see all
  // 3 slots even when fewer formals are declared, so we plumb the extras
  // (i.e. positionals beyond the declared formal count) through the
  // module-level __argc + __extras_argv globals consumed by
  // emitArgumentsVecBody. Convention from #1053: argc = numFormals
  // (slots filled by direct params); extras vec holds slots beyond.
  const SPEC_ARITY = 3;
  // Simple source callbacks neither construct `arguments` nor inspect omitted
  // parameters. Avoid allocating/boxing an extras vec on every array element.
  // Synthetic and dynamically recovered closures leave the metadata undefined
  // and conservatively retain the full call-site arity protocol.
  const argsPlumbing =
    closureInfo.needsCallSiteArity === false
      ? []
      : emitArrayCallbackArgsPlumbing(ctx, fctx, SPEC_ARITY, numParams, vecTypeIdx, arrTypeIdx, loop);

  // #2152 — install thisArg as the callback's `this` for the duration of the
  // call_ref. The callback body (funcexpr / named-decl that references `this`)
  // reads the `__current_this` module global with a null-guard (#1702), so
  // setting it here forwards the spec `thisArg`. Save the previous value first
  // (nesting safety) and restore it right after the call_ref. The restore
  // (`global.set`) does not disturb the call result already on the stack.
  // No host import — `__current_this` is a pure Wasm global, so this works
  // identically in standalone mode. Arrow callbacks never reach here with a
  // thisArgTmp (lexical `this`; see compileThisArg).
  const installThis: Instr[] =
    setup.thisArgTmp !== undefined && setup.prevThisTmp !== undefined && ctx.currentThisGlobalIdx >= 0
      ? [
          { op: "global.get", index: ctx.currentThisGlobalIdx },
          { op: "local.set", index: setup.prevThisTmp },
          { op: "local.get", index: setup.thisArgTmp },
          { op: "global.set", index: ctx.currentThisGlobalIdx },
        ]
      : [];
  const restoreThis: Instr[] =
    setup.thisArgTmp !== undefined && setup.prevThisTmp !== undefined && ctx.currentThisGlobalIdx >= 0
      ? [
          { op: "local.get", index: setup.prevThisTmp },
          { op: "global.set", index: ctx.currentThisGlobalIdx },
        ]
      : [];

  const inlineBody = instantiateInlineClosureBody(closureInfo, [
    [
      ...(elemSource.kind === "local"
        ? ([{ op: "local.get", index: elemSource.index }] satisfies Instr[])
        : ([
            { op: "local.get", index: loop.dataTmp },
            { op: "local.get", index: loop.iTmp },
            { op: loop.getOp, typeIdx: arrTypeIdx },
          ] satisfies Instr[])),
      ...(elemType.kind === "externref" && ctx.usesArrayHoles
        ? holeToUndefinedInstrs(ctx, fctx)
        : f64HoleToUndefFor(ctx, fctx, elemType)),
      ...elemCoerce,
    ],
    [
      { op: "local.get", index: loop.iTmp },
      ...coercionInstrs(ctx, { kind: "i32" }, closureInfo.paramTypes[1] ?? { kind: "i32" }, fctx),
    ],
    [
      { op: "local.get", index: loop.vecTmp },
      ...coercionInstrs(
        ctx,
        { kind: "ref_null", typeIdx: vecTypeIdx },
        closureInfo.paramTypes[2] ?? { kind: "ref_null", typeIdx: vecTypeIdx },
        fctx,
      ),
    ],
  ]);
  if (inlineBody) return inlineBody;

  return [
    ...argsPlumbing,
    ...installThis,
    { op: "local.get", index: closureTmp },
    // Element value (1st user param) — only pushed if callback declares ≥1 param.
    // A 0-arg callback (e.g. `function() {}`) compiles to a funcref that takes only
    // the closure env, so pushing elem here produces a call_ref signature mismatch.
    ...(numParams >= 1
      ? [
          ...(elemSource.kind === "local"
            ? ([{ op: "local.get", index: elemSource.index }] satisfies Instr[])
            : ([
                { op: "local.get", index: loop.dataTmp },
                { op: "local.get", index: loop.iTmp },
                { op: loop.getOp, typeIdx: arrTypeIdx },
              ] satisfies Instr[])),
          // (#2001 S1) Map a `$Hole` slot back to `undefined` before it reaches
          // the callback — a visited hole must present as `undefined`, never the
          // sentinel struct (forEach/map/etc still VISIT holes in S1; S2 adds
          // the visit-skip). Gated on externref element + `usesArrayHoles`.
          ...(elemType.kind === "externref" && ctx.usesArrayHoles
            ? holeToUndefinedInstrs(ctx, fctx)
            : f64HoleToUndefFor(ctx, fctx, elemType)),
          ...elemCoerce,
        ]
      : []),
    // Index (2nd user param)
    ...(numParams >= 2
      ? ([
          { op: "local.get", index: loop.iTmp },
          ...coercionInstrs(ctx, { kind: "i32" }, closureInfo.paramTypes[1] ?? { kind: "i32" }, fctx),
        ] satisfies Instr[])
      : []),
    // Array (3rd user param)
    ...(numParams >= 3
      ? ([
          { op: "local.get", index: loop.vecTmp },
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
    ...restoreThis,
  ];
}

/**
 * #820l — Emit __argc + __extras_argv plumbing for an inlined array-method
 * callback dispatch. The callee's `arguments` object reads these globals to
 * compute its true length and fill slots beyond the declared formal count.
 *
 * The array-method callback spec arity is fixed (3 for forEach/map/filter/etc.,
 * 4 for reduce). When `numParams < specArity` we build a fresh extras vec
 * containing the missing positional args boxed to externref so the
 * `arguments[i]` reads in the callee body still resolve correctly.
 */
function emitArrayCallbackArgsPlumbing(
  ctx: CodegenContext,
  fctx: FunctionContext,
  specArity: number,
  numParams: number,
  vecTypeIdx: number,
  arrTypeIdx: number,
  loop: ArrayLoopLocals,
): Instr[] {
  const argcGlobalIdx = ensureArgcGlobal(ctx);
  const { globalIdx: extrasGlobalIdx, vecTypeIdx: extrasVecTypeIdx } = ensureExtrasArgvGlobal(ctx);
  const extrasArrTypeIdx = getArrTypeIdxFromVec(ctx, extrasVecTypeIdx);
  void vecTypeIdx;

  // argc = numParams (the receive-side fills slots [0, numParams) from
  // direct param locals; extras start at offset numParams). The total
  // arguments.length is then argc + extrasLen = specArity.
  const instrs: Instr[] = [
    { op: "i32.const", value: numParams },
    { op: "global.set", index: argcGlobalIdx },
  ];

  if (numParams >= specArity) {
    // No extras — clear stale data from a prior invocation.
    instrs.push({ op: "ref.null", typeIdx: extrasVecTypeIdx });
    instrs.push({ op: "global.set", index: extrasGlobalIdx });
    return instrs;
  }

  // Build the extras as an externref array of length (specArity - numParams).
  // Slots in spec order — element, index, array — only the ones beyond the
  // declared formal count are included:
  //   numParams=0 → [elem, idx, arr]
  //   numParams=1 → [idx, arr]
  //   numParams=2 → [arr]
  const extrasCount = specArity - numParams;
  instrs.push({ op: "i32.const", value: extrasCount });
  const boxIdx = ctx.funcMap.get("__box_number");
  const pushBoxed = (): void => {
    if (boxIdx !== undefined) {
      instrs.push({ op: "call", funcIdx: boxIdx });
    } else {
      instrs.push({ op: "drop" });
      instrs.push({ op: "ref.null.extern" });
    }
  };
  if (numParams < 1) {
    // Push the element. Inline-load from data[i], coerced to externref.
    instrs.push({ op: "local.get", index: loop.dataTmp });
    instrs.push({ op: "local.get", index: loop.iTmp });
    instrs.push({ op: loop.getOp, typeIdx: arrTypeIdx });
    // The element type is whatever the array slot holds (i16/i32/f64/ref).
    // Use the receive-side's coercion convention by going through __box_number
    // for numeric types; for ref types use extern.convert_any.
    // We don't know the elemType here cheaply, so route through emitElemBoxing.
    instrs.push(...emitElemBoxToExternref(ctx, arrTypeIdx, loop.getOp));
  }
  if (numParams < 2) {
    instrs.push({ op: "local.get", index: loop.iTmp });
    instrs.push({ op: "f64.convert_i32_s" });
    pushBoxed();
  }
  if (numParams < 3) {
    instrs.push({ op: "local.get", index: loop.vecTmp });
    instrs.push({ op: "extern.convert_any" });
  }
  instrs.push({ op: "array.new_fixed", typeIdx: extrasArrTypeIdx, length: extrasCount });
  instrs.push({ op: "struct.new", typeIdx: extrasVecTypeIdx });
  instrs.push({ op: "global.set", index: extrasGlobalIdx });
  return instrs;
}

/**
 * Box a raw element value (whose type matches array `getOp` result) to an
 * externref. Mirrors the array-elem coercion paths used by emitArgumentsVecBody.
 */
function emitElemBoxToExternref(ctx: CodegenContext, arrTypeIdx: number, getOp: string): Instr[] {
  // (#3165) Box the loaded element (top of stack) to externref for the extras
  // vec. The previous stub DROPPED the element and pushed a null externref on
  // the claim that a 0-formal callback never reads its `arguments[0]` — false:
  // the test262 `predicate-call-parameters` family (~186 standalone fails,
  // TypedArray/Array callbackfn-arguments tests) does exactly
  // `sample.findIndex(function() { results.push(arguments); })` and asserts
  // `arguments[0]` is the element. The element's concrete ValType is the
  // backing ARRAY type's element def; packed i8/i16 arrays surface as i32 on
  // the stack via `array.get_s`/`array.get_u`.
  //
  // Boundary: a `$Hole` sentinel in a holey externref array rides through
  // as-is (the inline param path's holeToUndefined mapping is not applied
  // here) — same visibility as before for that edge; the numeric fast paths
  // are exact.
  const arrDef = ctx.mod.types[arrTypeIdx];
  const elem = arrDef && arrDef.kind === "array" ? (arrDef.element as ValType) : undefined;
  const undefFallback: Instr[] = [{ op: "drop" }, { op: "ref.null.extern" }];
  if (!elem) return undefFallback;
  if (elem.kind === "externref") return [];
  if (elem.kind === "ref" || elem.kind === "ref_null") return [{ op: "extern.convert_any" }];
  const boxIdx = ctx.funcMap.get("__box_number");
  const loadsAsI32 = elem.kind === "i32" || getOp === "array.get_s" || getOp === "array.get_u";
  if (elem.kind === "f64") {
    return boxIdx !== undefined ? [{ op: "call", funcIdx: boxIdx }] : undefFallback;
  }
  if (loadsAsI32) {
    return boxIdx !== undefined ? [{ op: "f64.convert_i32_s" }, { op: "call", funcIdx: boxIdx }] : undefFallback;
  }
  // Unboxable element kind (i64/v128/…) — keep the undefined placeholder.
  return undefFallback;
}

/**
 * Build host bridge call instructions for a 1-arg callback.
 * The element is always loaded inline from data[i].
 */
function buildBridgeCallInstrs(
  ctx: CodegenContext,
  setup: ArrayCallbackSetup,
  elemType: ValType,
  arrTypeIdx: number,
  loop: ArrayLoopLocals,
  elemSource: { kind: "local"; index: number } | { kind: "inline" },
): Instr[] {
  const conv =
    setup.bridgeArgType?.kind === "externref"
      ? emitElemBoxToExternref(ctx, arrTypeIdx, loop.getOp)
      : bridgeElemConvertInstrs(ctx, elemType);
  return [
    { op: "local.get", index: setup.cbTmp! },
    ...(elemSource.kind === "local"
      ? ([{ op: "local.get", index: elemSource.index }, ...conv] satisfies Instr[])
      : ([
          { op: "local.get", index: loop.dataTmp },
          { op: "local.get", index: loop.iTmp },
          { op: loop.getOp, typeIdx: arrTypeIdx },
          ...conv,
        ] satisfies Instr[])),
    { op: "call", funcIdx: setup.callBridgeIdx! },
  ];
}

/**
 * (#2934 host-bridge C) Convert a loop ELEMENT (as read from the backing
 * array) to the host bridge's numeric arg kind (`f64` in non-fast mode, `i32`
 * in fast mode). The old inline conversion only knew `i32 → f64`, so:
 *   - a BOXED-ANY (externref) element — `new Array(N)` / `any[]` vecs — flowed
 *     raw into the f64 param: `call[1] expected type f64, found array.get of
 *     type externref` (the `__closure_2/4` invalid-Wasm cluster,
 *     `filter/create-species-poisoned.js`);
 *   - a PACKED i8/i16 element reads as the widened i32 but compared as
 *     `elemType.kind === "i32"` → no convert → i32 into f64 (same class).
 * externref unboxes via `__unbox_number` (ToNumber; registered by
 * `addUnionImports` — native in standalone, import in host mode, resolved at
 * build time so the funcIdx is post-shift-correct and the pushed body is
 * walked by any later shifts).
 */
function bridgeElemConvertInstrs(ctx: CodegenContext, elemType: ValType): Instr[] {
  if (ctx.fast) return [];
  const readKind = elemType.kind === "i8" || elemType.kind === "i16" ? "i32" : elemType.kind;
  if (readKind === "i32") return [{ op: "f64.convert_i32_s" }];
  if (readKind === "externref" || readKind === "ref_extern") {
    addUnionImports(ctx);
    const unboxIdx = ctx.funcMap.get("__unbox_number");
    if (unboxIdx !== undefined) return [{ op: "call", funcIdx: unboxIdx }];
  }
  return [];
}

/** Build instructions to check truthiness of a callback result (-> i32). */
function buildTruthyCheck(ctx: CodegenContext, setup: ArrayCallbackSetup): Instr[] {
  if (setup.closureInfo) {
    // Void-returning callback (e.g. `function() {}`) leaves nothing on the
    // stack — `call_ref` consumed all its args and pushed no result. The
    // downstream `if`/`br_if` still needs an i32 condition, otherwise Wasm
    // validation rejects with "not enough arguments on the stack for if".
    // JS semantics: `undefined` is falsy → push i32.const 0. (#1522 Cluster 2)
    if (setup.closureInfo.returnType === null) {
      return [{ op: "i32.const", value: 0 }];
    }
    return buildToBooleanInstrs(ctx, setup.closureInfo.returnType);
  }
  // #2085 — non-closure (legacy) path: f64 result. Use |x|>0 so NaN/±0 are
  // falsy (the old `f64.ne 0` wrongly treated NaN as truthy), matching
  // `ensureI32Condition`.
  return ctx.fast ? [] : [{ op: "f64.abs" }, { op: "f64.const", value: 0 }, { op: "f64.gt" }];
}

/**
 * #2085 — spec §7.1.2 ToBoolean for an array-HOF callback result, mirroring the
 * canonical `ensureI32Condition` (src/codegen/index.ts) so the two hand-rolled
 * truthiness sites agree. Returns `Instr[]` (these helpers build instruction
 * lists rather than push to a body). Produces an i32 (1 = truthy).
 *   - f64        → |x| > 0   (NaN, +0, -0 all falsy; the old `f64.ne 0` made NaN truthy)
 *   - i32        → as-is (already 0/1-valued for the boolean callbacks)
 *   - externref  → `__is_truthy` (false/0/NaN/""/null/undefined → falsy)
 *   - any-boxed ref → `__any_unbox_bool` (proper JS truthiness on the boxed value)
 *   - native string ref → length > 0 (empty string is falsy)
 *   - other ref  → non-null (the only observable truthiness for opaque structs)
 */
function buildToBooleanInstrs(ctx: CodegenContext, retType: ValType): Instr[] {
  // #1917 — delegate to the single coercion engine (sink pattern: pass a fresh
  // array and return it). Behaviour-neutral — the engine's rows were transcribed
  // from this body (and #2085 already aligned it with `ensureI32Condition`).
  return emitToBoolean(ctx, retType, []);
}

/** Build instructions to check falsiness of a callback result (-> i32). */
function buildFalsyCheck(ctx: CodegenContext, setup: ArrayCallbackSetup): Instr[] {
  if (setup.closureInfo) {
    // Void-returning callback: result is `undefined`, which is falsy. Push
    // i32.const 1 so the consumer's `if`/`br_if` sees a "truthy" check-result
    // (i.e. the callback's return value WAS falsy). (#1522 Cluster 2)
    if (setup.closureInfo.returnType === null) {
      return [{ op: "i32.const", value: 1 }];
    }
    // #2085 — falsy == !truthy. Reuse the canonical ToBoolean then negate, so
    // NaN / boxed 0/""/false are correctly falsy (the old per-kind copy treated
    // NaN-as-truthy and boxed-falsy-as-truthy, the inverse of the #2085 bug).
    return [...buildToBooleanInstrs(ctx, setup.closureInfo.returnType), { op: "i32.eqz" }];
  }
  return ctx.fast
    ? [{ op: "i32.eqz" }]
    : [{ op: "f64.abs" }, { op: "f64.const", value: 0 }, { op: "f64.gt" }, { op: "i32.eqz" }];
}

/**
 * Emit the standard block/loop wrapper used by all functional array methods.
 */
function emitArrayLoop(fctx: FunctionContext, loopBody: Instr[]): void {
  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [{ op: "loop", blockType: { kind: "empty" }, body: loopBody }],
  });
}

/**
 * (#2001 S2) Should this externref-element vec loop emit a hole visit-skip?
 * Only when the module contains array-literal holes (`usesArrayHoles`) AND the
 * source element ValType is `externref` (the only rep that can physically hold
 * the `$Hole` sentinel). Typed (f64/i32/ref) element vecs and hole-free modules
 * are byte-identical — no `ref.test`, no gate.
 *
 * (PR #2832 merge-group park) ALSO disabled module-wide when the pre-scan saw
 * an `Array`/`Object.prototype` INDEX write (`protoIndexDirty`): §23.1.3.* keys the
 * skip on `HasProperty(O, k)`, which is TRUE for a hole whose index is
 * inherited from `Array.prototype` — a relationship the flat vec cannot check
 * per element. Falling back to the S1 visit-with-`undefined` behavior matches
 * the observable result of the dominant shape (inherited accessor without a
 * getter ⇒ [[Get]] is `undefined`) and un-regresses
 * `{every,filter,some}/*-c-i-22.js`.
 */
function shouldHoleSkip(ctx: CodegenContext, elemType: ValType, vecTypeIdx?: number): boolean {
  // The nominal carrier is only installed after the #4222 candidate scan has
  // proven that its own declaration-to-filter path cannot observe an indexed
  // prototype mutation.  `protoIndexDirty` can still be true for an unrelated,
  // never-called Test262 harness helper, so do not let that module-wide legacy
  // flag erase the carrier's locally-proven HasProperty behaviour.  Generic
  // externref vecs retain the old global guard: they have no such proof.
  const isBrandedHoleyCarrier = vecTypeIdx !== undefined && isHoleyArrayType(ctx, vecTypeIdx);
  if (isBrandedHoleyCarrier && elemType.kind === "externref") return true;
  if (ctx.usesArrayHoles && !ctx.protoIndexDirty) {
    if (elemType.kind === "externref") return true;
    // (#4491 T11) f64 joins externref here. Without it the value half is
    // LOUDLY wrong on arithmetic HOFs: `[1,2,3]` with `a[6]=5` reduced to NaN
    // (the marker is a NaN) where the spec skips the gap and answers 11 / 30.
    //
    // TWO disqualifiers, not one. `protoIndexDirty` (shared with externref)
    // covers an INHERITED index; `overlayRouteActive` covers an OWN one the
    // slot cannot show — `Object.defineProperty(arr, "1", {set: …})` records
    // an own accessor in the #3251 companion and writes nothing, so the marker
    // is still in the slot while the index IS present. A static own-slot test
    // cannot see that; the dynamic `__extern_has_idx` route can (it consults
    // the companion), and `overlayRouteActive` is exactly the condition under
    // which those reads take that route. Measured: without this, reduce and
    // reduceRight 15.4.4.2{1,2}-9-c-i-{18,20,22} regressed.
    return elemType.kind === "f64" && f64HolesActive(ctx) && !overlayRouteActive(ctx);
  }
  return false;
}

/**
 * (#2001 S2) Load `data[i]` and leave `i32 = 1` iff the slot is the `$Hole`
 * sentinel (an ABSENT index per §HasProperty). Reads the slot a second time
 * (the callback path reads it again for its own value); holes are rare
 * (`usesArrayHoles`-gated) so the extra `array.get` is acceptable.
 * Stack: `[] → [i32]`.
 */
function loadIsHoleInstrs(ctx: CodegenContext, loop: ArrayLoopLocals, arrTypeIdx: number, elemType?: ValType): Instr[] {
  return [
    { op: "local.get", index: loop.dataTmp },
    { op: "local.get", index: loop.iTmp },
    { op: loop.getOp, typeIdx: arrTypeIdx },
    // (#4491 T11) Per-carrier absence test: `ref.test $Hole` for externref, the
    // sNaN bit compare for f64. Both leave i32 = 1 iff the slot is absent.
    ...(elemType?.kind === "f64" ? f64HoleTestInstrs() : holeTestInstrs(ctx)),
  ];
}

/**
 * (#2001 S2) Visit-skip gate for a loop body that produces NO value and has no
 * loop/block-escaping `br` in `inner` (forEach). Wraps `inner` in
 * `if (present) { inner }` so a hole falls straight through to the caller's
 * `loopIncrement`. Byte-identical (`inner` unchanged) for typed / hole-free
 * vecs. Because the gate adds an `if` level, `inner` MUST NOT contain a `br`
 * that targets the loop/block — use {@link gateHoleFlag} for the escape
 * methods (some/every).
 */
function gateHoleSkip(
  ctx: CodegenContext,
  loop: ArrayLoopLocals,
  arrTypeIdx: number,
  elemType: ValType,
  inner: Instr[],
): Instr[] {
  if (!shouldHoleSkip(ctx, elemType)) return inner;
  return [
    ...loadIsHoleInstrs(ctx, loop, arrTypeIdx, elemType),
    { op: "i32.eqz" }, // 1 = present (NOT hole)
    { op: "if", blockType: { kind: "empty" }, then: inner },
  ];
}

/**
 * (#2001 S2) Visit-skip gate for a loop body whose per-iteration work leaves an
 * `i32` truthy/falsy FLAG on the stack (filter/some/every). A hole yields flag
 * `0` (not truthy, not falsy) so the caller's following `if` — which
 * matches/breaks/pushes on the flag — does nothing, and the callback is not
 * invoked. Crucially this does NOT add a control-flow level around the caller's
 * escaping `br`, so its `br` depths are unshifted. Stack: `[] → [i32]`.
 */
function gateHoleFlag(
  ctx: CodegenContext,
  loop: ArrayLoopLocals,
  arrTypeIdx: number,
  elemType: ValType,
  flagInner: Instr[],
  vecTypeIdx?: number,
): Instr[] {
  if (!shouldHoleSkip(ctx, elemType, vecTypeIdx)) return flagInner;
  return [
    ...loadIsHoleInstrs(ctx, loop, arrTypeIdx, elemType),
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [{ op: "i32.const", value: 0 }], // hole ⇒ flag 0 (skip)
      else: flagInner, // present ⇒ run callback + truthy/falsy check
    },
  ];
}

/**
 * Build the standard loop-exit check: if (i >= len) br 1.
 */
function loopExitCheck(loop: ArrayLoopLocals): Instr[] {
  return [
    { op: "local.get", index: loop.iTmp },
    { op: "local.get", index: loop.lenTmp },
    { op: "i32.ge_s" },
    { op: "br_if", depth: 1 },
  ];
}

/**
 * Build the standard i++ / br 0 at the end of each iteration.
 */
function loopIncrement(loop: ArrayLoopLocals): Instr[] {
  return [
    { op: "local.get", index: loop.iTmp },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.set", index: loop.iTmp },
    { op: "br", depth: 0 },
  ];
}

/**
 * Build callback call + optional truthiness/falsiness check for a 1-arg callback.
 * Used by filter, find, findIndex, some, every, forEach.
 */
function buildCallAndCheck(
  ctx: CodegenContext,
  fctx: FunctionContext,
  setup: ArrayCallbackSetup,
  elemType: ValType,
  vecTypeIdx: number,
  arrTypeIdx: number,
  loop: ArrayLoopLocals,
  elemSource: { kind: "local"; index: number } | { kind: "inline" },
  check: "truthy" | "falsy" | "none",
): Instr[] {
  const callInstrs = setup.closureInfo
    ? buildClosureCallInstrs(ctx, fctx, setup, elemType, vecTypeIdx, arrTypeIdx, loop, elemSource)
    : buildBridgeCallInstrs(ctx, setup, elemType, arrTypeIdx, loop, elemSource);
  const checkInstrs =
    check === "truthy" ? buildTruthyCheck(ctx, setup) : check === "falsy" ? buildFalsyCheck(ctx, setup) : [];
  return [...callInstrs, ...checkInstrs];
}

// ── Individual method implementations using shared helpers ──

/**
 * arr.filter(cb) -> iterate elements, call callback, build new array from truthy results.
 */
function compileArrayFilter(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
  receiverIsExternref = false,
): ValType | null {
  // ES spec: throw TypeError if callback is not a function
  if (emitCallbackTypeCheck(ctx, fctx, callExpr, "Array.prototype.filter")) {
    fctx.body.push({ op: "unreachable" });
    return { kind: "ref_null", typeIdx: vecTypeIdx };
  }

  const setup = setupArrayCallback(ctx, fctx, callExpr, "filter", "flt", undefined, 1);
  if (!setup) return null;

  const resLen = allocLocal(fctx, `__arr_flt_rl_${fctx.locals.length}`, { kind: "i32" });
  const elemTmp = allocLocal(fctx, `__arr_flt_el_${fctx.locals.length}`, elemType);

  const loop = setupArrayLoop(ctx, fctx, propAccess, vecTypeIdx, arrTypeIdx, elemType, "flt", receiverIsExternref);

  // §15.4.4.20 step 3: `len` is captured ONCE — see array-filter-spec-access.ts
  // for why the overlay route walks the LOGICAL length and the dense route the
  // #3215 backing-clamped one. Result capacity = one push per visited index.
  const rawOverlayElemLocal =
    elemType.kind === "f64" && ctx.protoIndexDirty
      ? allocLocal(fctx, `__arr_flt_raw_${fctx.locals.length}`, { kind: "externref" })
      : undefined;
  const overlay = overlayFilterAccess(ctx, fctx, loop, elemType, elemTmp, rawOverlayElemLocal);
  const resultVecTypeIdx =
    overlay?.rawElemLocal === undefined ? vecTypeIdx : getOrRegisterVecType(ctx, "externref", { kind: "externref" });
  const resultArrTypeIdx =
    overlay?.rawElemLocal === undefined ? arrTypeIdx : getArrTypeIdxFromVec(ctx, resultVecTypeIdx);
  const resultElemLocal = overlay?.rawElemLocal ?? elemTmp;
  const resData = allocLocal(fctx, `__arr_flt_rd_${fctx.locals.length}`, {
    kind: "ref_null",
    typeIdx: resultArrTypeIdx,
  });
  const boundTmp = overlay ? loop.logicalLenTmp : loop.lenTmp;
  // (#5145) §23.1.3.7 step 5 — `A = ArraySpeciesCreate(O, 0)`. Zero, not `len`:
  // `filter/create-species.js` asserts `args[0] === 0`.
  const speciesDeps = prepareArraySpeciesDeps(ctx, fctx);
  const speciesLocal =
    speciesDeps === undefined
      ? undefined
      : emitArraySpeciesCreate(
          ctx,
          fctx,
          speciesDeps,
          [{ op: "local.get", index: loop.vecTmp }, { op: "extern.convert_any" }],
          [{ op: "f64.const", value: 0 }],
        );
  fctx.body.push({ op: "local.get", index: boundTmp });
  fctx.body.push({ op: "array.new_default", typeIdx: resultArrTypeIdx });
  fctx.body.push({ op: "local.set", index: resData });

  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: resLen });

  const callAndCheck = buildCallAndCheck(
    ctx,
    fctx,
    setup,
    elemType,
    vecTypeIdx,
    arrTypeIdx,
    loop,
    { kind: "local", index: elemTmp },
    "truthy",
  );

  const loopBody: Instr[] = [
    // (#2001 S2) filter does not call the callback for a hole (§23.1.3.7 uses
    // HasProperty) and never adds it to the result. The flag-gate yields 0 for
    // a hole → the push `if` below does not fire (and the callback isn't run).
    ...filterSelectStage(loop, vecTypeIdx, arrTypeIdx, boundTmp, elemTmp, overlay, callAndCheck, (inner) =>
      gateHoleFlag(ctx, loop, arrTypeIdx, elemType, inner, vecTypeIdx),
    ),

    // if result is truthy, add element to result
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: resData },
        { op: "local.get", index: resLen },
        { op: "local.get", index: resultElemLocal },
        { op: "array.set", typeIdx: resultArrTypeIdx },
        { op: "local.get", index: resLen },
        { op: "i32.const", value: 1 },
        { op: "i32.add" },
        { op: "local.set", index: resLen },
      ],
    },

    ...loopIncrement(loop),
  ];

  emitArrayLoop(fctx, loopBody);

  fctx.body.push({ op: "local.get", index: resLen });
  fctx.body.push({ op: "local.get", index: resData });
  fctx.body.push({ op: "ref.as_non_null" });
  fctx.body.push({ op: "struct.new", typeIdx: resultVecTypeIdx });
  if (speciesDeps !== undefined && speciesLocal !== undefined) {
    return emitArraySpeciesResultSwap(ctx, fctx, speciesDeps, speciesLocal, {
      kind: "ref_null",
      typeIdx: resultVecTypeIdx,
    });
  }
  return { kind: "ref_null", typeIdx: resultVecTypeIdx };
}

/**
 * arr.map(cb) -> iterate elements, call callback, store results in new array.
 */
function compileArrayMap(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
  receiverIsExternref = false,
): ValType | null {
  // ES spec: throw TypeError if callback is not a function
  if (emitCallbackTypeCheck(ctx, fctx, callExpr, "Array.prototype.map")) {
    fctx.body.push({ op: "unreachable" });
    return { kind: "ref_null", typeIdx: vecTypeIdx };
  }

  const cbArg = callExpr.arguments[0]!;
  // Determine the result element type from the callback's own return type
  let mapResultElemType: ValType = elemType;
  let mapArrTypeIdx = arrTypeIdx;
  let mapVecTypeIdx = vecTypeIdx;

  if (ts.isArrowFunction(cbArg) || ts.isFunctionExpression(cbArg)) {
    const cbSig = ctx.checker.getSignatureFromDeclaration(cbArg);
    if (cbSig) {
      const retType = ctx.checker.getReturnTypeOfSignature(cbSig);
      const mapped = resolveWasmType(ctx, retType);
      // (#2688) Compare the FULL ValType (incl. struct typeIdx), not just `.kind`.
      // A shape-transforming `.map` whose callback returns a DIFFERENT ref struct
      // than the receiver's element struct is `ref`-vs-`ref` by kind, so the old
      // `.kind`-only check left the result array typed as the INPUT element struct
      // while the callback emitted a different struct → `array.set` validation
      // failure (apply-disable-directives.js, eslint Linter path).
      if (!valTypesMatch(mapped, elemType)) {
        mapResultElemType = mapped;
        mapArrTypeIdx = getOrRegisterArrayType(ctx, mapResultElemType.kind, mapResultElemType);
        mapVecTypeIdx = getOrRegisterVecType(ctx, mapResultElemType.kind, mapResultElemType);
      }
    }
  }

  // #4527 — an unresolved callback over reference-valued elements must retain
  // those values across the JS-host boundary. The legacy `__call_1_f64`
  // bridge applies ToNumber, turning Axios's string type names into NaN before
  // `kindOfTest(type)` can call `type.toLowerCase()`. Use the existing dynamic
  // externref bridge for this exact fallback shape; resolved closures stay on
  // call_ref and numeric-element maps keep their compact numeric bridge.
  const referenceElementBridge =
    !noJsHost(ctx) &&
    ctx.funcMap.has("__call_dyn_1") &&
    (elemType.kind === "externref" ||
      elemType.kind === "ref_extern" ||
      elemType.kind === "ref" ||
      elemType.kind === "ref_null");
  const savedMapCallbackFirstParamOverride = ctx.arrayMapCallbackFirstParamOverride;
  ctx.arrayMapCallbackFirstParamOverride = elemType;
  const setup = setupArrayCallback(
    ctx,
    fctx,
    callExpr,
    "map",
    "map",
    referenceElementBridge ? "__call_dyn_1" : undefined,
    1,
  );
  ctx.arrayMapCallbackFirstParamOverride = savedMapCallbackFirstParamOverride;
  if (!setup) return null;

  // Update map result type from the closure's ACTUAL compiled return type — the
  // ground truth for what `call_ref` produces. (#2688) typeIdx-aware so a
  // ref-struct return differing from the current result element struct is honored
  // (not just a differing kind).
  if (setup.closureInfo?.returnType && !valTypesMatch(setup.closureInfo.returnType, mapResultElemType)) {
    mapResultElemType = setup.closureInfo.returnType;
    mapArrTypeIdx = getOrRegisterArrayType(ctx, mapResultElemType.kind, mapResultElemType);
    mapVecTypeIdx = getOrRegisterVecType(ctx, mapResultElemType.kind, mapResultElemType);
  }
  // The dynamic bridge's callback result is intentionally opaque. Preserve it
  // as externref rather than forcing it back into the source element type; in
  // the Axios shape the mapped values are closures, not strings.
  if (setup.bridgeResultType?.kind === "externref" && mapResultElemType.kind !== "externref") {
    mapResultElemType = setup.bridgeResultType;
    mapArrTypeIdx = getOrRegisterArrayType(ctx, mapResultElemType.kind, mapResultElemType);
    mapVecTypeIdx = getOrRegisterVecType(ctx, mapResultElemType.kind, mapResultElemType);
  }

  // (#2001 S2 — map result-hole is DEFERRED; see the boundary note in the issue
  // file.) Spec §23.1.3.19 preserves absent indices: a source hole should yield
  // a RESULT hole (`join` renders it ""). Representing that needs the result vec
  // to be externref (to hold the `$Hole` sentinel), but TS types
  // `[1,,3].map(x=>x*10)` as `number[]`, so every downstream consumer (`.join`,
  // element read, arithmetic) is compiled against an f64 result and would
  // mis-read a forced-externref result. Closing it cleanly requires threading
  // the widened result type through the downstream type-flow — a separate slice.
  // Until then map VISITS the hole (the S1 read map presents `undefined` to the
  // callback), unchanged from pre-S2. The other skip methods
  // (forEach/filter/some/every/reduce/indexOf/lastIndexOf) are hole-correct.

  const loop = setupArrayLoop(ctx, fctx, propAccess, vecTypeIdx, arrTypeIdx, elemType, "map", receiverIsExternref);

  // (#5145) §23.1.3.19 step 5 — `A = ArraySpeciesCreate(O, len)`, BEFORE the
  // callback loop: `map/create-species-abrupt.js` and `-non-ctor.js` both
  // assert `callCount === 0` on an abrupt species completion.
  const speciesDeps = prepareArraySpeciesDeps(ctx, fctx);
  const speciesLocal =
    speciesDeps === undefined
      ? undefined
      : emitArraySpeciesCreate(
          ctx,
          fctx,
          speciesDeps,
          [{ op: "local.get", index: loop.vecTmp }, { op: "extern.convert_any" }],
          [{ op: "local.get", index: loop.logicalLenTmp }, { op: "f64.convert_i32_s" }],
        );

  const resData = allocLocal(fctx, `__arr_map_rd_${fctx.locals.length}`, { kind: "ref_null", typeIdx: mapArrTypeIdx });

  // Allocate result array with the LOGICAL length (§23.1.3.19 — map's result is
  // the same length as the source). (#3215) `loop.lenTmp` is clamped to the
  // physical backing for trap-safety, so size the result from the UNCLAMPED
  // `loop.logicalLenTmp`; the loop below only writes the in-backing prefix, and
  // the beyond-backing result slots stay default-initialised (consistent with
  // the #2001-S2 deferred map-result-hole behavior). Equal for dense arrays.
  fctx.body.push({ op: "local.get", index: loop.logicalLenTmp });
  fctx.body.push({ op: "array.new_default", typeIdx: mapArrTypeIdx });
  fctx.body.push({ op: "local.set", index: resData });

  // Build callback invocation (result stays on stack)
  let callInstrs: Instr[];
  if (setup.closureInfo) {
    const retType = setup.closureInfo.returnType;
    callInstrs = [
      ...buildClosureCallInstrs(ctx, fctx, setup, elemType, vecTypeIdx, arrTypeIdx, loop, { kind: "inline" }),
      // Void-returning callback (e.g. `function() {}`) pushes nothing → push a
      // default-of-mapResultElemType so the downstream `array.set` validates.
      // JS semantics: `undefined → mapped` maps to NaN/null/0 per type. (#1522)
      ...(retType === null
        ? defaultValueInstrs(mapResultElemType)
        : !valTypesMatch(retType, mapResultElemType)
          ? coercionInstrs(ctx, retType, mapResultElemType, fctx)
          : []),
    ];
  } else {
    const bridgeResultType = setup.bridgeResultType ?? (ctx.fast ? ({ kind: "i32" } as ValType) : { kind: "f64" });
    callInstrs = [
      ...buildBridgeCallInstrs(ctx, setup, elemType, arrTypeIdx, loop, { kind: "inline" }),
      // Coerce the bridge's declared result carrier to the result element type
      // so the downstream `array.set` validates. Numeric bridges retain the
      // #1601 f64→externref boxing; the #4527 dynamic bridge is already exact.
      ...(!valTypesMatch(bridgeResultType, mapResultElemType)
        ? coercionInstrs(ctx, bridgeResultType, mapResultElemType, fctx)
        : []),
    ];
  }

  const loopBody: Instr[] = [
    ...loopExitCheck(loop),

    // resData[i] = cb(data[i])
    { op: "local.get", index: resData },
    { op: "local.get", index: loop.iTmp },
    ...callInstrs,
    { op: "array.set", typeIdx: mapArrTypeIdx },

    ...loopIncrement(loop),
  ];

  emitArrayLoop(fctx, loopBody);

  // (#3215) Result vec length is the LOGICAL length (unclamped) so a sparse
  // source's map result keeps the source length (§23.1.3.19), matching the
  // logical-length `resData` allocation above.
  fctx.body.push({ op: "local.get", index: loop.logicalLenTmp });
  fctx.body.push({ op: "local.get", index: resData });
  fctx.body.push({ op: "ref.as_non_null" });
  fctx.body.push({ op: "struct.new", typeIdx: mapVecTypeIdx });
  if (speciesDeps !== undefined && speciesLocal !== undefined) {
    return emitArraySpeciesResultSwap(ctx, fctx, speciesDeps, speciesLocal, {
      kind: "ref_null",
      typeIdx: mapVecTypeIdx,
    });
  }
  return { kind: "ref_null", typeIdx: mapVecTypeIdx };
}

/**
 * Resolve the accumulator ValType for reduce/reduceRight.
 *
 * The accumulator holds whatever the callback returns between iterations, so
 * the callback's resolved return type is the most accurate source. We fall
 * back to the accumulator parameter type, then to the numeric kind. This
 * lets non-numeric accumulators (e.g. `string[].reduce((x,y)=>x+y)`) use an
 * `externref` local instead of being forced through a numeric unbox that
 * traps with "illegal cast" (#1994).
 */
function resolveReduceAccType(
  setup: ArrayCallbackSetup,
  numKind: "i32" | "f64",
  // (#3199) True when an explicit initial-value argument is a reference-typed
  // value (string / object / …). Seeds the accumulator when no callback type
  // pins it.
  initIsReference = false,
): ValType {
  const ci = setup.closureInfo;
  if (ci) {
    // A void-returning callback (returnType === null) yields `undefined`; keep
    // the numeric kind so the default-value path stays valid.
    if (ci.returnType && ci.returnType.kind !== numKind) {
      return ci.returnType;
    }
    if (ci.returnType) return ci.returnType;
    const accParam = ci.paramTypes[0];
    if (accParam && accParam.kind !== numKind) {
      return accParam;
    }
  }
  // (#3199) Callback type doesn't pin the accumulator (void / untyped callback,
  // e.g. `function () {}`). A reference-typed explicit initial value then seeds
  // it as `externref` instead of the numeric default — otherwise
  // `[].reduce(function () {}, "seed")` coerces the string seed to f64 (→ NaN).
  if (initIsReference) return { kind: "externref" };
  return { kind: numKind };
}

/**
 * (#3199) Whether a reduce/reduceRight initial value is reference-typed (the
 * externref-boxed tags) and so should seed the accumulator as externref.
 * Via the type oracle (#1930) — no direct TS-checker use. Numeric / boolean /
 * undefined / mixed tags keep the numeric default.
 */
function initArgIsReference(ctx: CodegenContext, initArg: ts.Expression): boolean {
  switch (ctx.oracle.staticJsTypeOf(initArg)) {
    case "string":
    case "object":
    case "function":
    case "symbol":
    case "bigint":
      return true;
    default:
      return false;
  }
}

/**
 * arr.reduce(cb, initial) -> iterate elements, accumulate result via callback.
 * Reduce has a 2-arg callback (acc, elem) so it uses custom call logic.
 */
function compileArrayReduce(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
  receiverIsExternref = false,
): ValType | null {
  // ES spec: throw TypeError if callback is not a function
  if (emitCallbackTypeCheck(ctx, fctx, callExpr, "Array.prototype.reduce")) {
    fctx.body.push({ op: "unreachable" });
    return elemType;
  }

  const numKind = ctx.fast ? "i32" : "f64";
  const bridgeName = ctx.fast ? "__call_2_i32" : "__call_2_f64";
  const setup = setupArrayCallback(ctx, fctx, callExpr, "reduce", "red", bridgeName);
  if (!setup) return null;

  // The accumulator local must match the actual accumulator type, not always
  // the numeric kind — string/object accumulators are externref (#1994). When a
  // void/untyped callback leaves the accumulator type unpinned, an explicit
  // reference-typed initial value seeds it as externref (#3199).
  const redInitIsRef = callExpr.arguments.length >= 2 && initArgIsReference(ctx, callExpr.arguments[1]!);
  const accType = resolveReduceAccType(setup, numKind, redInitIsRef);

  const loop = setupArrayLoop(ctx, fctx, propAccess, vecTypeIdx, arrTypeIdx, elemType, "red", receiverIsExternref);
  const accTmp = allocLocal(fctx, `__arr_red_acc_${fctx.locals.length}`, accType);

  // Compile initial value or use arr[0] as default
  if (callExpr.arguments.length >= 2) {
    compileExpression(ctx, fctx, callExpr.arguments[1]!, accType);
    fctx.body.push({ op: "local.set", index: accTmp });
    // i already = 0 from setupArrayLoop
  } else {
    // No initial value: throw TypeError on empty array, else acc = data[0], start from i = 1
    fctx.body.push({ op: "local.get", index: loop.lenTmp });
    fctx.body.push({ op: "i32.eqz" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: buildThrowJsErrorInstrs(ctx, "TypeError", "Reduce of empty array with no initial value", { flush: fctx }),
    });
    fctx.body.push({ op: "local.get", index: loop.dataTmp });
    fctx.body.push({ op: "i32.const", value: 0 });
    fctx.body.push({
      op: elemType.kind === "i8" ? "array.get_u" : elemType.kind === "i16" ? "array.get_s" : "array.get",
      typeIdx: arrTypeIdx,
    });
    // (#2001 S1) If data[0] is a `$Hole` (the no-initial-value seed), map it to
    // `undefined` before it becomes the accumulator. (#2001 S2 — reduce
    // hole-skip / first-present seed seek DEFERRED alongside indexOf: its
    // test262 coverage relies on prototype-inherited indices; see the S2
    // boundary note. Keeping S1 fold/seed here for net-0.)
    if (ctx.usesArrayHoles && elemType.kind === "externref") emitHoleToUndefined(ctx, fctx);
    emitF64HoleToUndef(ctx, fctx, elemType); // (#4491 T11) f64 twin
    // Coerce the seed element to the accumulator type (e.g. element externref
    // string → accumulator externref, or i32 element → f64 accumulator).
    coercionInstrs(ctx, elemType, accType, fctx).forEach((i) => fctx.body.push(i));
    fctx.body.push({ op: "local.set", index: accTmp });
    fctx.body.push({ op: "i32.const", value: 1 });
    fctx.body.push({ op: "local.set", index: loop.iTmp });
  }

  // Build reduce-specific callback invocation (2-arg: acc, elem)
  let callInstrs: Instr[];
  if (setup.closureInfo && setup.closureTypeIdx !== undefined && setup.closureTmp !== undefined) {
    const ci = setup.closureInfo;
    const numParams = ci.paramTypes.length;
    const accCoerce = ci.paramTypes[0] ? coercionInstrs(ctx, accType, ci.paramTypes[0], fctx) : [];
    const elemCoerce = ci.paramTypes[1] ? coercionInstrs(ctx, elemType, ci.paramTypes[1], fctx) : [];
    const elemLoad: Instr[] = [
      { op: "local.get", index: loop.dataTmp },
      { op: "local.get", index: loop.iTmp },
      { op: loop.getOp, typeIdx: arrTypeIdx },
      ...(ctx.usesArrayHoles && elemType.kind === "externref"
        ? holeToUndefinedInstrs(ctx, fctx)
        : f64HoleToUndefFor(ctx, fctx, elemType)),
      ...elemCoerce,
    ];
    const indexLoad: Instr[] = [
      { op: "local.get", index: loop.iTmp },
      ...coercionInstrs(ctx, { kind: "i32" }, ci.paramTypes[2] ?? { kind: "i32" }, fctx),
    ];
    const arrayLoad: Instr[] = [
      { op: "local.get", index: loop.vecTmp },
      ...coercionInstrs(
        ctx,
        { kind: "ref_null", typeIdx: vecTypeIdx },
        ci.paramTypes[3] ?? { kind: "ref_null", typeIdx: vecTypeIdx },
        fctx,
      ),
    ];
    const inlineBody = instantiateInlineClosureBody(ci, [
      [{ op: "local.get", index: accTmp }, ...accCoerce],
      elemLoad,
      indexLoad,
      arrayLoad,
    ]);
    const normalizeResult: Instr[] =
      ci.returnType === null
        ? defaultValueInstrs(accType)
        : ci.returnType.kind !== accType.kind
          ? coercionInstrs(ctx, ci.returnType, accType, fctx)
          : [];
    callInstrs = inlineBody
      ? [...inlineBody, ...normalizeResult, { op: "local.set", index: accTmp }]
      : [
          { op: "local.get", index: setup.closureTmp },
          ...(numParams >= 1 ? ([{ op: "local.get", index: accTmp }, ...accCoerce] satisfies Instr[]) : []),
          ...(numParams >= 2 ? elemLoad : []),
          ...(numParams >= 3 ? indexLoad : []),
          ...(numParams >= 4 ? arrayLoad : []),
          { op: "local.get", index: setup.closureTmp },
          { op: "struct.get", typeIdx: setup.closureTypeIdx, fieldIdx: 0 },
          ...guardedFuncRefCastInstrs(fctx, ci.funcTypeIdx),
          { op: "ref.as_non_null" },
          { op: "call_ref", typeIdx: ci.funcTypeIdx },
          ...normalizeResult,
          { op: "local.set", index: accTmp },
        ];
  } else {
    // Host-bridge fallback path: the bridge takes/returns the numeric kind, so
    // the accumulator must be numeric here. resolveReduceAccType returns the
    // numeric kind when there is no closureInfo, so accTmp is numeric too.
    callInstrs = [
      { op: "local.get", index: setup.cbTmp! },
      { op: "local.get", index: accTmp },
      { op: "local.get", index: loop.dataTmp },
      { op: "local.get", index: loop.iTmp },
      { op: loop.getOp, typeIdx: arrTypeIdx },
      // (#2934 host-bridge C) externref/packed elems convert to the bridge's
      // numeric arg kind — see bridgeElemConvertInstrs.
      ...bridgeElemConvertInstrs(ctx, elemType),
      { op: "call", funcIdx: setup.callBridgeIdx! },
      { op: "local.set", index: accTmp },
    ];
  }

  // (#2001 S2 left reduce folding ALL indices; #4491 T11 gates it.) §23.1.3.24
  // step 8.b runs HasProperty before each fold step. The externref carrier
  // could tolerate folding a hole (it read `undefined`, and `undefined` is
  // rarely an additive/multiplicative identity by luck); the f64 carrier cannot
  // — its marker is a NaN, so `[1,2,3]` with `a[6]=5` folded to NaN for BOTH
  // sum and product. `shouldHoleSkip` keeps the `protoIndexDirty` exclusion
  // that made S2 defer this: with an indexed prototype in play a bare own-slot
  // skip is not chain-inclusive HasProperty.
  //
  // NOT included: the no-initialValue SEED seek (step 6.b walks forward to the
  // first PRESENT index). The seed still reads index 0 and maps a hole to
  // `undefined`. That only differs when index 0 itself is a hole and no initial
  // value is passed; it was already wrong before this slice and is unchanged.
  const loopBody: Instr[] = [
    ...loopExitCheck(loop),
    ...gateHoleSkip(ctx, loop, arrTypeIdx, elemType, callInstrs),
    ...loopIncrement(loop),
  ];

  emitArrayLoop(fctx, loopBody);

  fctx.body.push({ op: "local.get", index: accTmp });
  return accType;
}

/**
 * arr.reduceRight(cb, init?) -> iterate elements right-to-left, accumulate via callback.
 */
function compileArrayReduceRight(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
  receiverIsExternref = false,
): ValType | null {
  // ES spec: throw TypeError if callback is not a function
  if (emitCallbackTypeCheck(ctx, fctx, callExpr, "Array.prototype.reduceRight")) {
    fctx.body.push({ op: "unreachable" });
    return elemType;
  }

  const numKind = ctx.fast ? "i32" : "f64";
  const bridgeName = ctx.fast ? "__call_2_i32" : "__call_2_f64";

  // (#2809) Pre-ensure `__get_undefined` BEFORE `setupArrayCallback` emits the
  // callback closure's `ref.func`. The seed/loop below map a `$Hole` element to
  // `undefined` via `holeToUndefinedInstrs`, which calls `emitUndefined` into a
  // DETACHED body — so its internal `flushLateImportShifts` patches that detached
  // array, NOT the real `fctx.body` holding the closure `ref.func`. If
  // `__get_undefined` is first registered there, the late-import funcIdx shift is
  // silently consumed and the closure `ref.func` is left pointing at the wrong
  // (pre-shift) function → `call_ref` dereferences a stale/null funcref and traps
  // (the regressed sparse-`[,,,]` `reduceRight` null-deref, reference_1461 class).
  // Registering it here, while `fctx.body` is the real body, makes the shift flush
  // against the right instrs and renders the later `holeToUndefinedInstrs`
  // registrations idempotent (no further shift).
  if (ctx.usesArrayHoles && elemType.kind === "externref") {
    ensureGetUndefined(ctx);
    flushLateImportShifts(ctx, fctx);
  }

  const setup = setupArrayCallback(ctx, fctx, callExpr, "reduceRight", "rr", bridgeName);
  if (!setup) return null;

  // The accumulator local must match the actual accumulator type, not always
  // the numeric kind — string/object accumulators are externref (#1994). A
  // reference-typed explicit initial value seeds an otherwise-unpinned
  // accumulator as externref (#3199).
  const rrInitIsRef = callExpr.arguments.length >= 2 && initArgIsReference(ctx, callExpr.arguments[1]!);
  const accType = resolveReduceAccType(setup, numKind, rrInitIsRef);

  // Set up receiver: vec/data/len
  const vecTmp = allocLocal(fctx, `__arr_rr_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const dataTmp = allocLocal(fctx, `__arr_rr_data_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const lenTmp = allocLocal(fctx, `__arr_rr_len_${fctx.locals.length}`, { kind: "i32" });
  const logicalLenTmp = allocLocal(fctx, `__arr_rr_loglen_${fctx.locals.length}`, { kind: "i32" });
  const iTmp = allocLocal(fctx, `__arr_rr_i_${fctx.locals.length}`, { kind: "i32" });

  const rrReceiverType = compileExpression(
    ctx,
    fctx,
    propAccess.expression,
    receiverIsExternref ? { kind: "externref" } : undefined,
  );
  // (#4536) Externref-carried receiver (e.g. a default-parameter `arr = []`
  // whose argument crossed the closure ABI as a `__make_iterable` mirror):
  // materialize back into the native vec instead of ref.cast-trapping. Same
  // arm as setupArrayLoop's #3996 handling.
  if (receiverIsExternref && rrReceiverType?.kind === "externref") {
    const externTmp = allocLocal(fctx, `__arr_rr_extern_${fctx.locals.length}`, { kind: "externref" });
    fctx.body.push({ op: "local.set", index: externTmp });
    fctx.body.push(...buildVecFromExternref(ctx, fctx, externTmp, vecTypeIdx, { arrTypeIdx, elemType }));
  }
  fctx.body.push({ op: "local.tee", index: vecTmp });
  emitReceiverNullGuard(ctx, fctx, vecTmp);
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenTmp });
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataTmp });

  // (#3215) reduceRight seeds from / iterates down from `length - 1`; clamp the
  // length to the physical backing so a sparse receiver does not TRAP on the
  // out-of-bounds `data[length-1]` seed read (or the reverse scan). Beyond-
  // backing indices are absent holes, skipped by reduceRight (§23.1.3.24), so
  // seeding from and iterating the physical prefix is spec-correct. No-op for
  // dense arrays. (reduceRight builds its own loop struct rather than going
  // through setupArrayLoop, so it gets the clamp inline.)
  fctx.body.push({ op: "local.get", index: lenTmp });
  fctx.body.push({ op: "local.set", index: logicalLenTmp });
  emitBackingLenClamp(fctx, lenTmp, dataTmp);

  const getOp = elemType.kind === "i8" ? "array.get_u" : elemType.kind === "i16" ? "array.get_s" : "array.get";
  const accTmp = allocLocal(fctx, `__arr_rr_acc_${fctx.locals.length}`, accType);

  // (#2001 S1 / #2809) `__get_undefined` is pre-ensured at the top of this
  // function (before the closure `ref.func` is emitted) so the detached
  // `holeToUndefinedInstrs` below can't shift a captured funcIdx.

  // Build the loop locals struct for buildClosureCallInstrs compatibility
  const loop: ArrayLoopLocals = {
    vecTmp,
    dataTmp,
    lenTmp,
    logicalLenTmp,
    iTmp,
    getOp,
  };

  // Compile initial value or use the last present element as the default seed.
  if (callExpr.arguments.length >= 2) {
    compileExpression(ctx, fctx, callExpr.arguments[1]!, accType);
    fctx.body.push({ op: "local.set", index: accTmp });
    // Start from length - 1
    fctx.body.push({ op: "local.get", index: lenTmp });
    fctx.body.push({ op: "i32.const", value: 1 });
    fctx.body.push({ op: "i32.sub" });
    fctx.body.push({ op: "local.set", index: iTmp });
  } else {
    // No initial value: throw TypeError on empty array, else acc = data[length-1], start from length - 2
    fctx.body.push({ op: "local.get", index: lenTmp });
    fctx.body.push({ op: "i32.eqz" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: buildThrowJsErrorInstrs(ctx, "TypeError", "Reduce of empty array with no initial value", { flush: fctx }),
    });
    fctx.body.push({ op: "local.get", index: dataTmp });
    fctx.body.push({ op: "local.get", index: lenTmp });
    fctx.body.push({ op: "i32.const", value: 1 });
    fctx.body.push({ op: "i32.sub" });
    fctx.body.push({ op: getOp, typeIdx: arrTypeIdx });
    // (#2001 S1) data[length-1] seed may be a `$Hole` → bind `undefined`.
    // (#2001 S2 — reduceRight hole-skip / last-present seed seek DEFERRED: its
    // test262 coverage relies on prototype-inherited indices; net-0 keeps S1.)
    if (ctx.usesArrayHoles && elemType.kind === "externref") emitHoleToUndefined(ctx, fctx);
    emitF64HoleToUndef(ctx, fctx, elemType); // (#4491 T11) f64 twin
    // Coerce the seed element to the accumulator type (e.g. element externref
    // string → accumulator externref, or i32 element → f64 accumulator).
    coercionInstrs(ctx, elemType, accType, fctx).forEach((i) => fctx.body.push(i));
    fctx.body.push({ op: "local.set", index: accTmp });
    fctx.body.push({ op: "local.get", index: lenTmp });
    fctx.body.push({ op: "i32.const", value: 2 });
    fctx.body.push({ op: "i32.sub" });
    fctx.body.push({ op: "local.set", index: iTmp });
  }

  // Build reduce-specific callback invocation (2-arg: acc, elem)
  let callInstrs: Instr[];
  if (setup.closureInfo && setup.closureTypeIdx !== undefined && setup.closureTmp !== undefined) {
    const ci = setup.closureInfo;
    const numParams = ci.paramTypes.length;
    const accCoerce = ci.paramTypes[0] ? coercionInstrs(ctx, accType, ci.paramTypes[0], fctx) : [];
    const elemCoerce = ci.paramTypes[1] ? coercionInstrs(ctx, elemType, ci.paramTypes[1], fctx) : [];
    callInstrs = [
      { op: "local.get", index: setup.closureTmp },
      ...(numParams >= 1 ? ([{ op: "local.get", index: accTmp }, ...accCoerce] satisfies Instr[]) : []),
      ...(numParams >= 2
        ? ([
            { op: "local.get", index: dataTmp },
            { op: "local.get", index: iTmp },
            { op: getOp, typeIdx: arrTypeIdx },
            // (#2001 S1) A `$Hole` element reaches the reducer as `undefined`.
            ...(ctx.usesArrayHoles && elemType.kind === "externref"
              ? holeToUndefinedInstrs(ctx, fctx)
              : f64HoleToUndefFor(ctx, fctx, elemType)),
            ...elemCoerce,
          ] satisfies Instr[])
        : []),
      ...(numParams >= 3
        ? ([
            { op: "local.get", index: iTmp },
            ...coercionInstrs(ctx, { kind: "i32" }, ci.paramTypes[2] ?? { kind: "i32" }, fctx),
          ] satisfies Instr[])
        : []),
      ...(numParams >= 4
        ? ([
            { op: "local.get", index: vecTmp },
            ...coercionInstrs(
              ctx,
              { kind: "ref_null", typeIdx: vecTypeIdx },
              ci.paramTypes[3] ?? { kind: "ref_null", typeIdx: vecTypeIdx },
              fctx,
            ),
          ] satisfies Instr[])
        : []),
      { op: "local.get", index: setup.closureTmp },
      { op: "struct.get", typeIdx: setup.closureTypeIdx, fieldIdx: 0 },
      ...guardedFuncRefCastInstrs(fctx, ci.funcTypeIdx),
      { op: "ref.as_non_null" },
      { op: "call_ref", typeIdx: ci.funcTypeIdx },
      // Void-returning callback (e.g. `function() {}`): nothing on stack →
      // push default-of-accumulator so the trailing `local.set accTmp`
      // validates. JS: cb returns `undefined` → acc becomes undefined →
      // for numeric kind that's NaN (f64) / 0 (i32). (#1522 Cluster 2)
      ...(ci.returnType === null
        ? defaultValueInstrs(accType)
        : ci.returnType.kind !== accType.kind
          ? coercionInstrs(ctx, ci.returnType, accType, fctx)
          : []),
      { op: "local.set", index: accTmp },
    ];
  } else {
    // Host-bridge fallback path: numeric accumulator (see compileArrayReduce).
    callInstrs = [
      { op: "local.get", index: setup.cbTmp! },
      { op: "local.get", index: accTmp },
      { op: "local.get", index: dataTmp },
      { op: "local.get", index: iTmp },
      { op: getOp, typeIdx: arrTypeIdx },
      // (#2934 host-bridge C) externref/packed elems convert to the bridge's
      // numeric arg kind — see bridgeElemConvertInstrs.
      ...bridgeElemConvertInstrs(ctx, elemType),
      { op: "call", funcIdx: setup.callBridgeIdx! },
      { op: "local.set", index: accTmp },
    ];
  }

  // (#4491 T11) Same §23.1.3.25 step 9.b HasProperty gate as `reduce` above —
  // and the same NaN-poisoning reason. This loop keeps its own hand-rolled
  // locals rather than `ArrayLoopLocals`, so the gate is spelled out here
  // instead of reusing `gateHoleSkip`; `callInstrs` has no escaping `br`, so
  // wrapping it in an `if` leaves the surrounding depths untouched.
  const holeGate = shouldHoleSkip(ctx, elemType);
  // Loop: while (i >= 0) { acc = cb(acc, data[i], i, arr); i--; }
  const loopBody: Instr[] = [
    // Exit check: if (i < 0) break
    { op: "local.get", index: iTmp },
    { op: "i32.const", value: 0 },
    { op: "i32.lt_s" },
    { op: "br_if", depth: 1 },
    // Callback
    ...(holeGate
      ? ([
          { op: "local.get", index: dataTmp },
          { op: "local.get", index: iTmp },
          { op: getOp, typeIdx: arrTypeIdx },
          ...(elemType.kind === "f64" ? f64HoleTestInstrs() : holeTestInstrs(ctx)),
          { op: "i32.eqz" },
          { op: "if", blockType: { kind: "empty" }, then: callInstrs },
        ] satisfies Instr[])
      : callInstrs),
    // i--
    { op: "local.get", index: iTmp },
    { op: "i32.const", value: 1 },
    { op: "i32.sub" },
    { op: "local.set", index: iTmp },
    { op: "br", depth: 0 },
  ];

  emitArrayLoop(fctx, loopBody);

  fctx.body.push({ op: "local.get", index: accTmp });
  return accType;
}

/**
 * arr.forEach(cb) -> iterate elements, call callback, return void.
 */
function compileArrayForEach(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
  receiverIsExternref = false,
): ValType | null {
  // ES spec: throw TypeError if callback is not a function
  if (emitCallbackTypeCheck(ctx, fctx, callExpr, "Array.prototype.forEach")) {
    fctx.body.push({ op: "unreachable" });
    return null; // void method
  }

  const setup = setupArrayCallback(ctx, fctx, callExpr, "forEach", "fe", undefined, 1);
  if (!setup) return null;

  const loop = setupArrayLoop(ctx, fctx, propAccess, vecTypeIdx, arrTypeIdx, elemType, "fe", receiverIsExternref);

  if (setup.closureInfo) {
    const callInstrs = buildClosureCallInstrs(ctx, fctx, setup, elemType, vecTypeIdx, arrTypeIdx, loop, {
      kind: "inline",
    });
    const dropInstrs: Instr[] = setup.closureInfo.returnType ? [{ op: "drop" }] : [];

    // (#2001 S2) forEach does not call the callback for a hole (§23.1.3.15 uses
    // HasProperty). Gate the call+drop; a hole falls through to loopIncrement.
    const loopBody: Instr[] = [
      ...loopExitCheck(loop),
      ...gateHoleSkip(ctx, loop, arrTypeIdx, elemType, [...callInstrs, ...dropInstrs]),
      ...loopIncrement(loop),
    ];

    emitArrayLoop(fctx, loopBody);
  } else {
    const callInstrs = buildBridgeCallInstrs(ctx, setup, elemType, arrTypeIdx, loop, { kind: "inline" });

    const loopBody: Instr[] = [
      ...loopExitCheck(loop),
      ...gateHoleSkip(ctx, loop, arrTypeIdx, elemType, [...callInstrs, { op: "drop" }]),
      ...loopIncrement(loop),
    ];

    emitArrayLoop(fctx, loopBody);
  }

  return null;
}

/**
 * arr.find(cb) -> iterate, return first element where cb returns truthy, else NaN.
 */
function compileArrayFind(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
  receiverIsExternref = false,
): ValType | null {
  // ES spec: throw TypeError if callback is not a function
  if (emitCallbackTypeCheck(ctx, fctx, callExpr, "Array.prototype.find")) {
    fctx.body.push({ op: "unreachable" });
    return elemType;
  }

  const setup = setupArrayCallback(ctx, fctx, callExpr, "find", "find", undefined, 1);
  if (!setup) return null;

  const elemTmpLocal = allocLocal(fctx, `__arr_find_el_${fctx.locals.length}`, elemType);

  const loop = setupArrayLoop(ctx, fctx, propAccess, vecTypeIdx, arrTypeIdx, elemType, "find", receiverIsExternref);

  const callAndCheck = buildCallAndCheck(
    ctx,
    fctx,
    setup,
    elemType,
    vecTypeIdx,
    arrTypeIdx,
    loop,
    { kind: "local", index: elemTmpLocal },
    "truthy",
  );

  // #2507 — a boxed-any (`externref`) element array (`any[]`, `new Array(N)`)
  // returns the matched ELEMENT, which is an `externref`, not an f64. The
  // non-fast default below assumes a numeric element and types the result local
  // f64 with a NaN "not found" sentinel — which then `local.set`s the externref
  // element into an f64 local ("expected f64, found externref"). Keep the result
  // as `externref` for an externref element (and use `ref.null.extern` — the
  // `undefined` sentinel — for "not found", which is the spec result anyway).
  const elemIsExternref = elemType.kind === "externref";
  // (#3126) ref/ref_null element (native-string / object-struct arrays): the
  // result is the element's NULLABLE ref with a `ref.null` "not found"
  // sentinel — the typed lane's `undefined` rep (same rep pop()/at() misses
  // use). The numeric NaN sentinel below would `local.set` a GC ref into an
  // f64 local (invalid Wasm).
  const refElemResType: ValType | undefined =
    elemType.kind === "ref" || elemType.kind === "ref_null"
      ? { kind: "ref_null", typeIdx: (elemType as { typeIdx: number }).typeIdx }
      : undefined;
  // Result local -- null/NaN/undefined (not found) or element value
  const findResType: ValType = refElemResType ?? (ctx.fast || elemIsExternref ? elemType : { kind: "f64" });
  const findResTmp = allocLocal(fctx, `__arr_find_res_${fctx.locals.length}`, findResType);
  if (refElemResType) {
    fctx.body.push({ op: "ref.null", typeIdx: refElemResType.typeIdx });
  } else if (elemIsExternref) {
    fctx.body.push({ op: "ref.null.extern" });
  } else if (ctx.fast) {
    fctx.body.push({ op: "i32.const", value: 0 });
  } else {
    fctx.body.push({ op: "f64.const", value: 0 });
    fctx.body.push({ op: "f64.const", value: 0 });
    fctx.body.push({ op: "f64.div" }); // NaN
  }
  fctx.body.push({ op: "local.set", index: findResTmp });

  // (#2001 S1) Map a `$Hole` slot to `undefined` as the element is latched into
  // `elemTmpLocal` — so BOTH the callback (via the local elemSource) and the
  // returned matched element present `undefined`, never the sentinel. find still
  // VISITS the hole in S1 (S2 adds the skip). Pre-ensure done in setupArrayLoop.
  const findHoleMap: Instr[] =
    ctx.usesArrayHoles && elemType.kind === "externref"
      ? holeToUndefinedInstrs(ctx, fctx)
      : f64HoleToUndefFor(ctx, fctx, elemType);

  const loopBody: Instr[] = [
    ...loopExitCheck(loop),

    { op: "local.get", index: loop.dataTmp },
    { op: "local.get", index: loop.iTmp },
    { op: loop.getOp, typeIdx: arrTypeIdx },
    ...findHoleMap,
    { op: "local.set", index: elemTmpLocal },

    ...callAndCheck,
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: elemTmpLocal },
        ...(!ctx.fast && elemType.kind === "i32" ? ([{ op: "f64.convert_i32_s" }] satisfies Instr[]) : []),
        { op: "local.set", index: findResTmp },
        { op: "br", depth: 2 },
      ],
    },

    ...loopIncrement(loop),
  ];

  emitArrayLoop(fctx, loopBody);

  fctx.body.push({ op: "local.get", index: findResTmp });
  return findResType;
}

/**
 * arr.findIndex(cb) -> iterate, return index (f64) of first truthy cb result, else -1.
 */
function compileArrayFindIndex(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
  receiverIsExternref = false,
): ValType | null {
  // ES spec: throw TypeError if callback is not a function
  if (emitCallbackTypeCheck(ctx, fctx, callExpr, "Array.prototype.findIndex")) {
    fctx.body.push({ op: "unreachable" });
    return { kind: "i32" };
  }

  const setup = setupArrayCallback(ctx, fctx, callExpr, "findIndex", "fi", undefined, 1);
  if (!setup) return null;

  const loop = setupArrayLoop(ctx, fctx, propAccess, vecTypeIdx, arrTypeIdx, elemType, "fi", receiverIsExternref);

  const callAndCheck = buildCallAndCheck(
    ctx,
    fctx,
    setup,
    elemType,
    vecTypeIdx,
    arrTypeIdx,
    loop,
    { kind: "inline" },
    "truthy",
  );

  const fiResType: ValType = ctx.fast ? { kind: "i32" } : { kind: "f64" };
  const fiResTmp = allocLocal(fctx, `__arr_fi_res_${fctx.locals.length}`, fiResType);
  if (ctx.fast) {
    fctx.body.push({ op: "i32.const", value: -1 });
  } else {
    fctx.body.push({ op: "f64.const", value: -1 });
  }
  fctx.body.push({ op: "local.set", index: fiResTmp });

  const loopBody: Instr[] = [
    ...loopExitCheck(loop),

    ...callAndCheck,
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: loop.iTmp },
        ...(ctx.fast ? [] : ([{ op: "f64.convert_i32_s" }] satisfies Instr[])),
        { op: "local.set", index: fiResTmp },
        { op: "br", depth: 2 },
      ],
    },

    ...loopIncrement(loop),
  ];

  emitArrayLoop(fctx, loopBody);

  fctx.body.push({ op: "local.get", index: fiResTmp });
  return ctx.fast ? { kind: "i32" } : { kind: "f64" };
}

/**
 * Reverse-iteration setup for findLast/findLastIndex (§23.1.3.12/.13): start the
 * cursor at len-1 instead of 0. Reuses `setupArrayLoop`'s vec/data/len read, then
 * overwrites `iTmp = len - 1`. Pair with `loopExitCheckReverse`/`loopDecrement`.
 */
function setupArrayLoopReverse(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
  tag: string,
  receiverIsExternref = false,
): ArrayLoopLocals {
  const loop = setupArrayLoop(ctx, fctx, propAccess, vecTypeIdx, arrTypeIdx, elemType, tag, receiverIsExternref);
  // i = len - 1 (setupArrayLoop left it at 0).
  fctx.body.push({ op: "local.get", index: loop.lenTmp });
  fctx.body.push({ op: "i32.const", value: 1 });
  fctx.body.push({ op: "i32.sub" });
  fctx.body.push({ op: "local.set", index: loop.iTmp });
  return loop;
}

/** Reverse loop-exit check: if (i < 0) br 1. */
function loopExitCheckReverse(loop: ArrayLoopLocals): Instr[] {
  return [
    { op: "local.get", index: loop.iTmp },
    { op: "i32.const", value: 0 },
    { op: "i32.lt_s" },
    { op: "br_if", depth: 1 },
  ];
}

/** Reverse i-- / br 0 at the end of each iteration. */
function loopDecrement(loop: ArrayLoopLocals): Instr[] {
  return [
    { op: "local.get", index: loop.iTmp },
    { op: "i32.const", value: 1 },
    { op: "i32.sub" },
    { op: "local.set", index: loop.iTmp },
    { op: "br", depth: 0 },
  ];
}

/**
 * arr.findLast(cb) -> iterate from the last index toward 0, return the first
 * element whose callback result is truthy, else undefined (NaN in non-fast mode).
 * Mirror of compileArrayFind but reverse-iterating (§23.1.3.12).
 */
function compileArrayFindLast(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
  receiverIsExternref = false,
): ValType | null {
  if (emitCallbackTypeCheck(ctx, fctx, callExpr, "Array.prototype.findLast")) {
    fctx.body.push({ op: "unreachable" });
    return elemType;
  }

  const setup = setupArrayCallback(ctx, fctx, callExpr, "findLast", "findLast", undefined, 1);
  if (!setup) return null;

  const elemTmpLocal = allocLocal(fctx, `__arr_findLast_el_${fctx.locals.length}`, elemType);

  const loop = setupArrayLoopReverse(
    ctx,
    fctx,
    propAccess,
    vecTypeIdx,
    arrTypeIdx,
    elemType,
    "findLast",
    receiverIsExternref,
  );

  const callAndCheck = buildCallAndCheck(
    ctx,
    fctx,
    setup,
    elemType,
    vecTypeIdx,
    arrTypeIdx,
    loop,
    { kind: "local", index: elemTmpLocal },
    "truthy",
  );

  // #2507 — boxed-any (`externref`) element array returns the externref element,
  // not an f64; keep the result type externref with a `ref.null.extern`
  // (undefined) "not found" sentinel. See compileArrayFind.
  const elemIsExternref = elemType.kind === "externref";
  // (#3126) ref/ref_null element: nullable elem ref + `ref.null` sentinel —
  // see compileArrayFind.
  const refElemResType: ValType | undefined =
    elemType.kind === "ref" || elemType.kind === "ref_null"
      ? { kind: "ref_null", typeIdx: (elemType as { typeIdx: number }).typeIdx }
      : undefined;
  const findResType: ValType = refElemResType ?? (ctx.fast || elemIsExternref ? elemType : { kind: "f64" });
  const findResTmp = allocLocal(fctx, `__arr_findLast_res_${fctx.locals.length}`, findResType);
  if (refElemResType) {
    fctx.body.push({ op: "ref.null", typeIdx: refElemResType.typeIdx });
  } else if (elemIsExternref) {
    fctx.body.push({ op: "ref.null.extern" });
  } else if (ctx.fast) {
    fctx.body.push({ op: "i32.const", value: 0 });
  } else {
    fctx.body.push({ op: "f64.const", value: 0 });
    fctx.body.push({ op: "f64.const", value: 0 });
    fctx.body.push({ op: "f64.div" }); // NaN (undefined sentinel)
  }
  fctx.body.push({ op: "local.set", index: findResTmp });

  // (#2001 S1) Map a `$Hole` slot to `undefined` as the element is latched, so
  // both the callback and the returned element present `undefined`.
  const findLastHoleMap: Instr[] =
    ctx.usesArrayHoles && elemType.kind === "externref"
      ? holeToUndefinedInstrs(ctx, fctx)
      : f64HoleToUndefFor(ctx, fctx, elemType);

  const loopBody: Instr[] = [
    ...loopExitCheckReverse(loop),

    { op: "local.get", index: loop.dataTmp },
    { op: "local.get", index: loop.iTmp },
    { op: loop.getOp, typeIdx: arrTypeIdx },
    ...findLastHoleMap,
    { op: "local.set", index: elemTmpLocal },

    ...callAndCheck,
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: elemTmpLocal },
        ...(!ctx.fast && elemType.kind === "i32" ? ([{ op: "f64.convert_i32_s" }] satisfies Instr[]) : []),
        { op: "local.set", index: findResTmp },
        { op: "br", depth: 2 },
      ],
    },

    ...loopDecrement(loop),
  ];

  emitArrayLoop(fctx, loopBody);

  fctx.body.push({ op: "local.get", index: findResTmp });
  return findResType;
}

/**
 * arr.findLastIndex(cb) -> reverse-iterate, return index (f64/i32) of the last
 * element whose callback result is truthy, else -1. Mirror of compileArrayFindIndex
 * but reverse-iterating (§23.1.3.13).
 */
function compileArrayFindLastIndex(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
  receiverIsExternref = false,
): ValType | null {
  if (emitCallbackTypeCheck(ctx, fctx, callExpr, "Array.prototype.findLastIndex")) {
    fctx.body.push({ op: "unreachable" });
    return { kind: "i32" };
  }

  const setup = setupArrayCallback(ctx, fctx, callExpr, "findLastIndex", "fli", undefined, 1);
  if (!setup) return null;

  const loop = setupArrayLoopReverse(
    ctx,
    fctx,
    propAccess,
    vecTypeIdx,
    arrTypeIdx,
    elemType,
    "fli",
    receiverIsExternref,
  );

  const callAndCheck = buildCallAndCheck(
    ctx,
    fctx,
    setup,
    elemType,
    vecTypeIdx,
    arrTypeIdx,
    loop,
    { kind: "inline" },
    "truthy",
  );

  const fliResType: ValType = ctx.fast ? { kind: "i32" } : { kind: "f64" };
  const fliResTmp = allocLocal(fctx, `__arr_fli_res_${fctx.locals.length}`, fliResType);
  if (ctx.fast) {
    fctx.body.push({ op: "i32.const", value: -1 });
  } else {
    fctx.body.push({ op: "f64.const", value: -1 });
  }
  fctx.body.push({ op: "local.set", index: fliResTmp });

  const loopBody: Instr[] = [
    ...loopExitCheckReverse(loop),

    ...callAndCheck,
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: loop.iTmp },
        ...(ctx.fast ? [] : ([{ op: "f64.convert_i32_s" }] satisfies Instr[])),
        { op: "local.set", index: fliResTmp },
        { op: "br", depth: 2 },
      ],
    },

    ...loopDecrement(loop),
  ];

  emitArrayLoop(fctx, loopBody);

  fctx.body.push({ op: "local.get", index: fliResTmp });
  return ctx.fast ? { kind: "i32" } : { kind: "f64" };
}

/**
 * arr.some(cb) -> returns i32 (1 if any element passes callback, 0 otherwise).
 */
function compileArraySome(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
  receiverIsExternref = false,
): ValType | null {
  // ES spec: throw TypeError if callback is not a function
  if (emitCallbackTypeCheck(ctx, fctx, callExpr, "Array.prototype.some")) {
    fctx.body.push({ op: "unreachable" });
    return { kind: "i32" };
  }

  const setup = setupArrayCallback(ctx, fctx, callExpr, "some", "some", undefined, 1);
  if (!setup) return null;

  const loop = setupArrayLoop(ctx, fctx, propAccess, vecTypeIdx, arrTypeIdx, elemType, "some", receiverIsExternref);

  const callAndCheck = buildCallAndCheck(
    ctx,
    fctx,
    setup,
    elemType,
    vecTypeIdx,
    arrTypeIdx,
    loop,
    { kind: "inline" },
    "truthy",
  );

  const resTmp = allocLocal(fctx, `__arr_some_res_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: resTmp });

  const loopBody: Instr[] = [
    ...loopExitCheck(loop),

    // (#2001 S2) some does not call the callback for a hole (§23.1.3.28 uses
    // HasProperty). The flag-gate yields 0 (not truthy) for a hole, so the
    // match `if` below does not fire and scanning continues.
    ...gateHoleFlag(ctx, loop, arrTypeIdx, elemType, callAndCheck),
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "i32.const", value: 1 },
        { op: "local.set", index: resTmp },
        { op: "br", depth: 2 },
      ],
    },

    ...loopIncrement(loop),
  ];

  emitArrayLoop(fctx, loopBody);

  fctx.body.push({ op: "local.get", index: resTmp });
  return { kind: "i32" };
}

/**
 * arr.every(cb) -> returns i32 (1 if all elements pass callback, 0 otherwise).
 */
function compileArrayEvery(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
  receiverIsExternref = false,
): ValType | null {
  // ES spec: throw TypeError if callback is not a function
  if (emitCallbackTypeCheck(ctx, fctx, callExpr, "Array.prototype.every")) {
    fctx.body.push({ op: "unreachable" });
    return { kind: "i32" };
  }

  const setup = setupArrayCallback(ctx, fctx, callExpr, "every", "evr", undefined, 1);
  if (!setup) return null;

  const loop = setupArrayLoop(ctx, fctx, propAccess, vecTypeIdx, arrTypeIdx, elemType, "evr", receiverIsExternref);

  const callAndCheck = buildCallAndCheck(
    ctx,
    fctx,
    setup,
    elemType,
    vecTypeIdx,
    arrTypeIdx,
    loop,
    { kind: "inline" },
    "falsy",
  );

  const resTmp = allocLocal(fctx, `__arr_evr_res_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "i32.const", value: 1 });
  fctx.body.push({ op: "local.set", index: resTmp });

  const loopBody: Instr[] = [
    ...loopExitCheck(loop),

    // (#2001 S2) every does not call the callback for a hole (§23.1.3.6 uses
    // HasProperty). The flag-gate yields 0 (not falsy) for a hole, so the
    // falsify `if` below does not fire and a hole never makes `every` false.
    ...gateHoleFlag(ctx, loop, arrTypeIdx, elemType, callAndCheck),
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "i32.const", value: 0 },
        { op: "local.set", index: resTmp },
        { op: "br", depth: 2 },
      ],
    },

    ...loopIncrement(loop),
  ];

  emitArrayLoop(fctx, loopBody);

  fctx.body.push({ op: "local.get", index: resTmp });
  return { kind: "i32" };
}

/**
 * arr.sort() -> in-place Timsort, return same vec ref.
 * Only supported for numeric element types (i32, f64).
 */
function compileArraySort(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
): ValType | null {
  // #1361: Spec §23.1.3.30 step 1 — if comparefn is provided and is not a
  // function, throw TypeError BEFORE any sort work begins. Fires only when
  // the argument is known statically to be non-callable (null, number,
  // string, etc.); `undefined` is explicitly allowed as "no comparator".
  if (callExpr.arguments.length >= 1) {
    const cbArg = callExpr.arguments[0]!;
    const isExplicitUndefined =
      cbArg.kind === ts.SyntaxKind.UndefinedKeyword || (ts.isIdentifier(cbArg) && cbArg.text === "undefined");
    if (!isExplicitUndefined && isKnownNonCallable(ctx, cbArg)) {
      // Compile the receiver and arg for side effects, then throw. The receiver
      // expression may have getters that mutate state — spec evaluation order
      // is "evaluate receiver, evaluate args, validate arg, then sort". Doing
      // both keeps user code observable.
      const recvType = compileExpression(ctx, fctx, propAccess.expression);
      if (recvType) fctx.body.push({ op: "drop" });
      const cbType = compileExpression(ctx, fctx, cbArg);
      if (cbType) fctx.body.push({ op: "drop" });
      emitThrowTypeError(ctx, fctx, "Array.prototype.sort comparator is not a function");
      fctx.body.push({ op: "unreachable" });
      return { kind: "ref_null", typeIdx: vecTypeIdx };
    }
  }

  // #1816: if a callable comparator is supplied, honor it. The default Timsort
  // hard-codes numeric `<`/`<=` and ignores any comparefn, so route comparator
  // sorts through a stable insertion sort that invokes the comparator closure
  // via `call_ref` (§23.1.3.30 / SortIndexedProperties / CompareArrayElements).
  if (callExpr.arguments.length >= 1) {
    const cbArg = callExpr.arguments[0]!;
    const isExplicitUndefined =
      cbArg.kind === ts.SyntaxKind.UndefinedKeyword || (ts.isIdentifier(cbArg) && cbArg.text === "undefined");
    if (!isExplicitUndefined) {
      const comparatorResult = tryCompileComparatorSort(ctx, fctx, propAccess, cbArg, vecTypeIdx, arrTypeIdx, elemType);
      if (comparatorResult) return comparatorResult;
      // Fell through (comparator not a compilable closure) — fall back to the
      // default numeric Timsort below. This keeps non-closure comparators
      // (rare) compiling without a hard error, matching prior behaviour.
    }
  }

  // #1993 — with no comparator, §23.1.3.30 compares elements by ToString, NOT
  // numerically. The default Timsort hard-codes numeric `<`, so `[10,9,1,100]`
  // sorted to "1,9,10,100" instead of the spec "1,10,100,9", and string arrays
  // weren't ordered at all. Route numeric and string element arrays through the
  // ToString-comparing insertion sort. Other element kinds keep the numeric
  // Timsort (their ToString ordering isn't yet modeled).
  const isStringElem = elemType.kind === "ref" || elemType.kind === "ref_null" || elemType.kind === "externref";
  if (elemType.kind === "f64" || elemType.kind === "i32" || isStringElem) {
    const defaultResult = compileArrayDefaultToStringSort(ctx, fctx, propAccess, vecTypeIdx, arrTypeIdx, elemType);
    if (defaultResult) return defaultResult;
    // Fell through (e.g. helpers unavailable) — fall back to numeric Timsort,
    // but ONLY for numeric element kinds (below): the numeric Timsort hard-codes
    // `f64.gt`/`i32.gt_s`, so routing a ref/externref element array here mints
    // `__isort_<kind>` with a comparator that does `f64.gt` on a non-numeric
    // `array.get` → invalid Wasm (#2502). For non-numeric kinds, leave the array
    // as-is (a no-op sort) rather than emit a poisoned binary.
  }

  // #2502 — the numeric Timsort is valid only for i32/f64 element arrays. A
  // ref/externref-element array whose default ToString sort fell through above
  // must NOT reach `ensureTimsortHelper` (the `elemType.kind as "i32"|"f64"`
  // cast is a lie for externref and produces `f64.gt` on an externref element).
  // Emit a no-op (return the receiver unchanged) — correct for the common holes
  // case (`new Array(2)` is all `undefined`, already sorted) and never invalid.
  if (elemType.kind !== "i32" && elemType.kind !== "f64") {
    const vecTmp0 = allocLocal(fctx, `__arr_sort_noop_${fctx.locals.length}`, {
      kind: "ref_null",
      typeIdx: vecTypeIdx,
    });
    compileExpression(ctx, fctx, propAccess.expression);
    fctx.body.push({ op: "local.tee", index: vecTmp0 });
    emitReceiverNullGuard(ctx, fctx, vecTmp0);
    fctx.body.push({ op: "local.get", index: vecTmp0 });
    fctx.body.push({ op: "ref.as_non_null" });
    return { kind: "ref_null", typeIdx: vecTypeIdx };
  }

  const elemKind = elemType.kind as "i32" | "f64";
  const timsortIdx = ensureTimsortHelper(ctx, vecTypeIdx, arrTypeIdx, elemKind);

  const vecTmp = allocLocal(fctx, `__arr_sort_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });

  // Compile receiver, save a copy for return value
  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.tee", index: vecTmp });
  emitReceiverNullGuard(ctx, fctx, vecTmp);

  // Call timsort(vec)
  fctx.body.push({ op: "call", funcIdx: timsortIdx });

  // Return the same vec ref (sort is in-place)
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "ref.as_non_null" });
  return { kind: "ref_null", typeIdx: vecTypeIdx };
}

/**
 * #1993 — default (no-comparator) `Array.prototype.sort` per §23.1.3.30:
 * elements are compared by ToString, producing lexicographic order
 * (`[10,9,1,100]` → `[1,10,100,9]`). Emits an in-place stable insertion sort
 * whose comparison stringifies each element and compares the strings:
 *   - numeric element → `number_toString` (host: externref; native: native
 *     string boxed as externref → converted to `$AnyString`);
 *   - string element → used directly.
 * String comparison uses `__str_compare` (native) or `string_compare` (host),
 * both returning i32 sign. Returns the (in-place sorted) vec, or `null` if the
 * required helpers are unavailable (caller falls back to the numeric Timsort).
 */
/**
 * (#3201/#3215) In-place clamp of an array method's length local to the
 * physical WasmGC backing: `lenLocal = min(lenLocal, array.len(dataLocal))`. A
 * sparse array (logical `.length` set beyond the backing) would otherwise trap
 * on the out-of-bounds `array.get`/`array.set` in the method's element loop.
 * The beyond-backing indices are holes that every affected method treats as
 * absent (sort moves them to the end §23.1.3.30; the HasProperty-driven HOFs
 * SKIP them), so iterating only the defined physical prefix is spec-correct.
 * No-op for dense arrays (backing ≥ length ⇒ min is the length).
 */
function emitBackingLenClamp(fctx: FunctionContext, lenLocal: number, dataLocal: number): void {
  fctx.body.push({ op: "local.get", index: lenLocal });
  fctx.body.push({ op: "local.get", index: dataLocal });
  fctx.body.push({ op: "array.len" });
  fctx.body.push({ op: "i32.lt_s" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "i32" } },
    then: [{ op: "local.get", index: lenLocal }],
    else: [{ op: "local.get", index: dataLocal }, { op: "array.len" }],
  });
  fctx.body.push({ op: "local.set", index: lenLocal });
}

function compileArrayDefaultToStringSort(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
): ValType | null {
  const isNumeric = elemType.kind === "f64" || elemType.kind === "i32";
  // (#3902 → #3912) This used to carry a host-import DETECTION probe:
  //
  //     const numToStrExisting = ctx.funcMap.get("number_toString");
  //     const importedFuncCount = ctx.mod.imports.filter(…).length;
  //     const numToStrIsHostImport = numToStrExisting < importedFuncCount;
  //
  // …because `import-collector.ts` gated the two helpers this function needs on
  // DIFFERENT conditions: `string_compare` was skipped under `ctx.nativeStrings`
  // (the native `__str_compare` replaces it), while `number_toString` went
  // native only under `ctx.wasi || ctx.standalone`. In plain `nativeStrings`
  // mode — i.e. `fast: true`, the whole gc-native lane — the module got the
  // JS-HOST `env.number_toString`, whose genuine JS string then failed
  // `stringifyTail`'s `any.convert_extern` + `ref.cast $AnyString` with an
  // `illegal cast` trap on every numeric `arr.sort()`.
  //
  // #3912 removed the mismatch at its source: `number_toString` is now native
  // wherever strings are native (`usesNativeNumberFormat`), so
  // `numToStrIsHostImport` can no longer be true while `ctx.nativeStrings` is —
  // the probe was dead code. Removed here, together with #3902's temporary
  // `coercion-sites-allow` for this file, exactly as #3902's frontmatter
  // instructed. `native` is now the plain question it always meant to ask.
  const native = ctx.nativeStrings && ctx.nativeStrTypeIdx >= 0;
  // (#3579) HOST default sort only supports numeric or externref (boxed-any /
  // js-string) elements. A ref/ref_null (struct) element cannot flow into the
  // `string_compare(externref, externref)` host import, so bail to the caller's
  // no-op rather than emit an invalid `string_compare(ref struct, …)`. (Native
  // mode already bailed above for the externref case.)
  if (!native && !isNumeric && elemType.kind !== "externref") {
    return null;
  }

  // #2379 — in NATIVE-string mode this ToString sort's non-numeric branch
  // `ref.cast`s each `array.get` element to `$AnyString` (see `stringifyTail`),
  // which is sound only for a NativeString-typed element ref. A raw `externref`
  // element is a *boxed-any* value (e.g. `new Array(N)` holes, an `any[]`), NOT a
  // NativeString — `ref.cast` of an `(ref extern)` against `(ref $AnyString)` is
  // invalid Wasm (different reference-type hierarchies → "ref.as_non_null of
  // (ref extern) has to be in the same reference type hierarchy as (ref N)" in
  // `__module_init`). Bail so the caller no-ops the sort (#2502) instead of
  // emitting a poisoned binary. Boxed-any ToString-order sorting is a separate
  // follow-up needing a runtime any→string step, not this static cast.
  // HOST mode is unaffected: there `cmpStrType` is `externref` and the string
  // branch emits only `ref.as_non_null` (no cast), so a host externref element
  // sorts correctly — do NOT bail there or valid host string sorts break.
  if (!isNumeric && native && elemType.kind === "externref") {
    return null;
  }

  // Comparison-string type + the compare/stringify helpers per backend.
  let cmpStrType: ValType;
  let compareIdx: number | undefined;
  let numToStrIdx: number | undefined;
  let anyStrTypeIdx = -1;
  // (#3579) HOST mode, non-numeric (boxed-`any`/externref element) branch: the
  // element must be ToString'd via the runtime `__extern_toString` before the
  // string comparison. Previously `stringifyTail` assumed the element was ALREADY
  // a string (`ref.as_non_null` only) — true for `string[]` but NOT for an
  // `any[]` whose elements are boxed numbers/undefined, so `string_compare` on
  // raw boxed values could not order them and the default sort silently no-op'd
  // (`[10,9,1].sort()` on an untyped array stayed unordered). `__extern_toString`
  // is the SAME runtime primitive `emitToString`'s dynamic branch wraps and is
  // already used directly in this file (compileArrayJoinExtern); reusing it needs
  // no `ts.Type`/checker query. Ensured BEFORE the `string_compare` funcMap lookup
  // so the captured `compareIdx` reflects any import-insertion index shift.
  let externToStrIdx: number | undefined;
  if (native) {
    ensureNativeStringHelpers(ctx);
    anyStrTypeIdx = ctx.anyStrTypeIdx;
    compareIdx = ctx.nativeStrHelpers.get("__str_compare");
    cmpStrType = { kind: "ref", typeIdx: anyStrTypeIdx };
    if (isNumeric) {
      emitNativeNumberFormat(ctx, new Set(["number_toString"]));
      numToStrIdx = ctx.funcMap.get("number_toString");
    }
  } else {
    cmpStrType = { kind: "externref" };
    if (!isNumeric) {
      externToStrIdx = ensureLateImport(ctx, "__extern_toString", [{ kind: "externref" }], [{ kind: "externref" }]);
      flushLateImportShifts(ctx, fctx);
      if (externToStrIdx === undefined) return null;
    }
    // (#3902) In `nativeStrings` mode import-collector deliberately skips the
    // `string_compare` host import (the native `__str_compare` normally covers
    // it), so the host fallback selected above has no comparator yet. Add it
    // late — and flush BEFORE reading the two indices below, since inserting an
    // import shifts every function index.
    if (!ctx.funcMap.has("string_compare")) {
      const added = ensureLateImport(
        ctx,
        "string_compare",
        [{ kind: "externref" }, { kind: "externref" }],
        [{ kind: "i32" }],
      );
      flushLateImportShifts(ctx, fctx);
      if (added === undefined) return null;
    }
    compareIdx = ctx.funcMap.get("string_compare");
    if (isNumeric) numToStrIdx = ctx.funcMap.get("number_toString");
  }
  if (compareIdx === undefined || (isNumeric && numToStrIdx === undefined)) {
    return null; // helpers not registered — caller no-ops (#2502) or numeric Timsort
  }

  const vecTmp = allocLocal(fctx, `__dsort_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const dataTmp = allocLocal(fctx, `__dsort_data_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const lenTmp = allocLocal(fctx, `__dsort_len_${fctx.locals.length}`, { kind: "i32" });

  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.tee", index: vecTmp });
  emitReceiverNullGuard(ctx, fctx, vecTmp);
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenTmp });
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataTmp });

  // (#3201) Clamp the sort length to the physical WasmGC backing so a sparse
  // array (logical `.length` set beyond the backing) does not TRAP on the
  // out-of-bounds `array.get`/`array.set` below. Per §23.1.3.30 the absent
  // beyond-backing indices are holes that sort to the END, so sorting only the
  // physical defined prefix and leaving the holes in place is spec-correct.
  // Dense vecs keep `lenTmp` (backing ≥ length ⇒ runtime no-op).
  emitBackingLenClamp(fctx, lenTmp, dataTmp);

  const getOp: Instr["op"] =
    elemType.kind === "i8" ? "array.get_u" : elemType.kind === "i16" ? "array.get_s" : "array.get";

  // Stringify an element value (already on the stack as elemType) to cmpStrType.
  const stringifyTail = (): Instr[] => {
    if (!isNumeric) {
      if (!native && externToStrIdx !== undefined && elemType.kind === "externref") {
        // (#3579) HOST boxed-`any`/string element → runtime ToString before the
        // string comparison. A real string passes through (`ToString(str)===str`);
        // a boxed number/undefined is stringified ("10"/"undefined"), so an
        // untyped-array default sort orders by ToString per §23.1.3.30 instead of
        // no-op'ing. Pass the RAW (nullable) externref straight to
        // `__extern_toString` — it handles null (`String(null)`→"null"), so a
        // `new Array(N)` all-holes array must NOT be `ref.as_non_null`'d first
        // (that traps on the null holes; #2502 regression). Only the externref
        // (boxed-any) element kind is retargeted — every other kind keeps its
        // exact prior lowering (no regression surface).
        return [{ op: "call", funcIdx: externToStrIdx }];
      }
      // String element: ensure non-null, and (native) cast NativeString → AnyString.
      const out: Instr[] = [{ op: "ref.as_non_null" }];
      if (native) out.push({ op: "ref.cast", typeIdx: anyStrTypeIdx });
      return out;
    }
    const out: Instr[] = [];
    if (elemType.kind !== "f64") out.push({ op: "f64.convert_i32_s" });
    out.push({ op: "call", funcIdx: numToStrIdx! });
    if (native) {
      out.push({ op: "any.convert_extern" });
      out.push({ op: "ref.cast", typeIdx: anyStrTypeIdx });
    }
    return out;
  };

  // (#3902) `string_compare(ToString(left), ToString(right)) > 0`.
  //
  // The insertion sort this replaced hoisted the RIGHT operand's stringification
  // out of the inner loop (it was always the same `key`), so it paid one
  // `number_toString` per comparison instead of two. The merge sort pays two —
  // but it performs `n·log₂ n` comparisons instead of `n²/4`, so on the
  // 10,000-element `array/sort-i32` benchmark that is 2×133,000 = 266,000
  // stringifications instead of 25,000,000: a ~94× net reduction in host calls
  // on top of the algorithmic win. Caching the per-element string in a parallel
  // array would remove the remaining factor of ~13 (n·log n → n) and is the
  // obvious follow-up if the default ToString sort ever becomes hot.
  const compareGtZero = (pushLeft: Instr[], pushRight: Instr[]): Instr[] => [
    ...pushLeft,
    ...stringifyTail(),
    ...pushRight,
    ...stringifyTail(),
    { op: "call", funcIdx: compareIdx },
    { op: "i32.const", value: 0 },
    { op: "i32.gt_s" },
  ];

  emitStableMergeSort(fctx, {
    arrTypeIdx,
    getOp,
    dataLocal: dataTmp,
    lenLocal: lenTmp,
    buildCompareGtZero: compareGtZero,
  });

  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "ref.as_non_null" });
  return { kind: "ref_null", typeIdx: vecTypeIdx };
}

/**
 * #1816 — comparator-aware sort. Emits an in-place stable sort that invokes the
 * user comparator closure via `call_ref` at every comparison, using the spec
 * ordering: `comparator(a, b) > 0` ⇒ `a` sorts after `b`.
 *
 * Returns the result ValType on success, or `null` if the comparator is not a
 * compilable Wasm closure (caller then falls back to the default Timsort).
 *
 * (#3902) The sort itself is the shared stable bottom-up MERGE sort
 * (`emitStableMergeSort`), not the insertion sort this originally shipped with.
 * The original rationale for insertion sort was that it is naturally stable and
 * keeps the comparator-call site inline in the calling function so the closure
 * local stays in scope — merge sort keeps both properties (it is emitted inline
 * too) while cutting comparator invocations from `n²/4` to `n·log₂ n`. That was
 * worth ~190× on the `array/sort-i32` benchmark: every comparison here is a
 * `call_ref` through a closure struct, which is far too expensive to do
 * quadratically.
 */
function tryCompileComparatorSort(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  cbArg: ts.Expression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
): ValType | null {
  // Compile the comparator. Arrow/function expressions become closures; an
  // identifier referencing a closure variable also resolves to one.
  const cbResult =
    ts.isArrowFunction(cbArg) || ts.isFunctionExpression(cbArg)
      ? compileArrowAsClosure(ctx, fctx, cbArg)
      : compileExpression(ctx, fctx, cbArg);
  if (!cbResult || (cbResult.kind !== "ref" && cbResult.kind !== "ref_null")) {
    // Not a Wasm closure (e.g. a host externref function). Drop and bail so the
    // caller falls back to the default sort.
    if (cbResult) fctx.body.push({ op: "drop" });
    return null;
  }
  const closureTypeIdx = (cbResult as { typeIdx: number }).typeIdx;
  const closureInfo = ctx.closureInfoByTypeIdx.get(closureTypeIdx);
  if (!closureInfo || closureInfo.paramTypes.length < 2) {
    // Unknown closure shape or fewer than 2 params — can't drive a 2-arg
    // comparator soundly. Drop and fall back.
    fctx.body.push({ op: "drop" });
    return null;
  }

  const cmpTmp = allocLocal(fctx, `__arr_sort_cmp_${fctx.locals.length}`, cbResult);
  fctx.body.push({ op: "local.set", index: cmpTmp });

  // Now compile the receiver (spec order: comparefn already evaluated above as
  // the arg; receiver was the member-expression base, evaluated first at the
  // call site — but here we evaluate it after for codegen simplicity, which is
  // observationally identical for the array receiver, which has no getter).
  const vecTmp = allocLocal(fctx, `__arr_sort_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const dataTmp = allocLocal(fctx, `__arr_sort_data_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const lenTmp = allocLocal(fctx, `__arr_sort_len_${fctx.locals.length}`, { kind: "i32" });

  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.tee", index: vecTmp });
  emitReceiverNullGuard(ctx, fctx, vecTmp);
  // len = vec.length, data = vec.data
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenTmp });
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataTmp });

  // (#3201) Clamp the comparator sort length to the physical backing so a sparse
  // receiver does not trap on the out-of-bounds element access below. Holes sort
  // to the end (§23.1.3.30); no-op for dense arrays.
  emitBackingLenClamp(fctx, lenTmp, dataTmp);

  const getOp: Instr["op"] =
    elemType.kind === "i8" ? "array.get_u" : elemType.kind === "i16" ? "array.get_s" : "array.get";

  // Comparator-call instruction sequence with the two operands pushed by the
  // caller-supplied sequences as `elemType`; coerces each to the closure's
  // declared param type, invokes call_ref, coerces the (f64/typed) result to
  // f64, leaves an i32 `(result > 0)` on the stack.
  // Comparator call convention (matches the other array-method call_ref sites):
  // push the closure struct (`__self`, the 1st funcType param) FIRST, then the
  // two user args, then re-fetch the funcref from the struct (field 0) and
  // `call_ref`. The funcType is `[__self, p0, p1] -> ret`.
  const cmpReturn: ValType = closureInfo.returnType ?? { kind: "f64" };
  const buildCompareGtZero = (pushLeft: Instr[], pushRight: Instr[]): Instr[] => [
    { op: "local.get", index: cmpTmp }, // __self
    ...pushLeft,
    ...coercionInstrs(ctx, elemType, closureInfo.paramTypes[0]!, fctx),
    ...pushRight,
    ...coercionInstrs(ctx, elemType, closureInfo.paramTypes[1]!, fctx),
    { op: "local.get", index: cmpTmp },
    { op: "struct.get", typeIdx: closureTypeIdx, fieldIdx: 0 },
    ...guardedFuncRefCastInstrs(fctx, closureInfo.funcTypeIdx),
    { op: "ref.as_non_null" },
    { op: "call_ref", typeIdx: closureInfo.funcTypeIdx },
    ...coercionInstrs(ctx, cmpReturn, { kind: "f64" }, fctx),
    { op: "f64.const", value: 0 },
    { op: "f64.gt" },
  ];

  // (#3902) Stable bottom-up merge sort — `n·log₂ n` comparator invocations
  // instead of the `n²/4` the previous insertion sort needed.
  emitStableMergeSort(fctx, {
    arrTypeIdx,
    getOp,
    dataLocal: dataTmp,
    lenLocal: lenTmp,
    buildCompareGtZero,
  });

  // Return the same vec ref (sort is in-place).
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "ref.as_non_null" });
  return { kind: "ref_null", typeIdx: vecTypeIdx };
}

/**
 * arr.fill(value, start?, end?) -> fill elements with value, return same vec ref.
 * Mutates the array in place.
 */
/**
 * (#5145) §7.1.5 ToIntegerOrInfinity → §7.1.4 ToNumber step 3: a **Symbol** in
 * an index-argument position throws a TypeError. `fill`/`copyWithin` compile
 * their index args in `{kind: "f64"}` context, where a Symbol (lowered to an
 * i32 id) coerces SILENTLY — measured: `[1,2,3].fill(0, Symbol())` did not
 * throw. Mirrors `emitSymbolToNumberThrow` (`expressions/unary.ts`), including
 * its oracle-only type question.
 *
 * Emits the receiver + every argument (each dropped) before the throw so the
 * observable evaluation order of a normal call is preserved, then the throw.
 * Returns true when it fired; a dynamic externref Symbol keeps the existing
 * silent path (the rarer shape — every ES2015 file passes `Symbol()` literally).
 */
function emitSymbolIndexArgThrow(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  indexArgPositions: readonly number[],
): boolean {
  const hasSymbolIndexArg = indexArgPositions.some((position) => {
    const arg = callExpr.arguments[position];
    return arg !== undefined && ctx.oracle.staticJsTypeOf(arg) === "symbol";
  });
  if (!hasSymbolIndexArg) return false;
  const receiverType = compileExpression(ctx, fctx, propAccess.expression);
  if (receiverType !== null) fctx.body.push({ op: "drop" });
  for (const arg of callExpr.arguments) {
    const argType = compileExpression(ctx, fctx, arg);
    if (argType !== null) fctx.body.push({ op: "drop" });
  }
  emitThrowTypeError(ctx, fctx, "Cannot convert a Symbol value to a number");
  return true;
}

function compileArrayFill(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
): ValType | null {
  if (callExpr.arguments.length < 1) {
    reportError(ctx, callExpr, "fill requires at least 1 argument");
    return null;
  }
  // fill(value, start, end) — positions 1 and 2 are the index args.
  if (emitSymbolIndexArgThrow(ctx, fctx, propAccess, callExpr, [1, 2])) {
    fctx.body.push({ op: "unreachable" });
    return { kind: "ref_null", typeIdx: vecTypeIdx };
  }

  const vecTmp = allocLocal(fctx, `__arr_fill_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const dataTmp = allocLocal(fctx, `__arr_fill_data_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const lenTmp = allocLocal(fctx, `__arr_fill_len_${fctx.locals.length}`, { kind: "i32" });
  // (#2159) Byte/short typed arrays (Uint8Array/Int8Array/Int16Array/…) have a
  // PACKED `i8`/`i16` element type, valid only in array elements / struct
  // fields — never in a value position. Allocating the fill-value local with the
  // raw packed `elemType` leaked it into a local, which the binary emitter
  // rejects (`packed storage type "i8" is not valid in a value position`),
  // making `.fill()` a hard compile error for every byte/short typed array
  // standalone. Hold the value as the unpacked `i32`; `array.set` re-packs it on
  // store (mirrors the element-assignment fix in assignment.ts).
  const valType: ValType = elemType.kind === "i8" || elemType.kind === "i16" ? { kind: "i32" } : elemType;
  const valTmp = allocLocal(fctx, `__arr_fill_val_${fctx.locals.length}`, valType);
  const startTmp = allocLocal(fctx, `__arr_fill_s_${fctx.locals.length}`, { kind: "i32" });
  const endTmp = allocLocal(fctx, `__arr_fill_e_${fctx.locals.length}`, { kind: "i32" });
  const iTmp = allocLocal(fctx, `__arr_fill_i_${fctx.locals.length}`, { kind: "i32" });

  // Compile receiver -> vec ref
  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.tee", index: vecTmp });
  emitReceiverNullGuard(ctx, fctx, vecTmp);

  // Extract length
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenTmp });

  // Extract data
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataTmp });

  // Compile value argument (unpacked hint — never pass the packed i8/i16).
  compileExpression(ctx, fctx, callExpr.arguments[0]!, valType);
  fctx.body.push({ op: "local.set", index: valTmp });

  // start (default: 0) -- clamp negative
  if (callExpr.arguments.length >= 2) {
    if (ctx.fast) {
      compileExpression(ctx, fctx, callExpr.arguments[1]!, { kind: "i32" });
    } else {
      compileExpression(ctx, fctx, callExpr.arguments[1]!, { kind: "f64" });
      fctx.body.push({ op: "i32.trunc_sat_f64_s" });
    }
  } else {
    fctx.body.push({ op: "i32.const", value: 0 });
  }
  fctx.body.push({ op: "local.set", index: startTmp });
  emitClampIndex(fctx, startTmp, lenTmp);

  // end (default: length) -- clamp negative
  // Spec §23.1.3.7 step 7: if end is undefined, use len; else ToIntegerOrInfinity(end).
  // Treat statically-`undefined` arguments (literal `undefined` / `void 0`) as missing,
  // because once coerced to f64 we cannot distinguish them from `NaN` (which spec says → 0).
  const fillEndArg = callExpr.arguments.length >= 3 ? callExpr.arguments[2]! : undefined;
  const fillEndIsUndef =
    fillEndArg !== undefined &&
    ((ts.isIdentifier(fillEndArg) && fillEndArg.text === "undefined") || ts.isVoidExpression(fillEndArg));
  if (fillEndArg !== undefined && !fillEndIsUndef) {
    if (ctx.fast) {
      compileExpression(ctx, fctx, fillEndArg, { kind: "i32" });
    } else {
      compileExpression(ctx, fctx, fillEndArg, { kind: "f64" });
      fctx.body.push({ op: "i32.trunc_sat_f64_s" });
    }
  } else {
    fctx.body.push({ op: "local.get", index: lenTmp });
  }
  fctx.body.push({ op: "local.set", index: endTmp });
  emitClampIndex(fctx, endTmp, lenTmp);

  // (#3201 write-path) On a SPARSE array (logical `.length` set beyond the
  // WasmGC backing via `a.length = N`) the write range `[start, end)` runs past
  // `array.len(data)` and the `array.set` below TRAPS ("array element access out
  // of bounds"). `fill` writes its range unconditionally (§23.3.3.7 has no
  // HasProperty guard), so grow the backing to the clamped `end` first — then
  // the whole loop lands in-bounds and materialises the (formerly absent) slots
  // as required. Standalone/WASI-gated so the host/gc lane stays byte-identical;
  // a dense receiver (capacity ≥ end) makes the grow a runtime no-op.
  if (ctx.standalone || ctx.wasi) {
    emitEnsureBackingCapacity(fctx, vecTmp, dataTmp, vecTypeIdx, arrTypeIdx, endTmp);
  }

  // i = start
  fctx.body.push({ op: "local.get", index: startTmp });
  fctx.body.push({ op: "local.set", index: iTmp });

  // Loop: while (i < end) { data[i] = value; i++; }
  const loopBody: Instr[] = [
    { op: "local.get", index: iTmp },
    { op: "local.get", index: endTmp },
    { op: "i32.ge_s" },
    { op: "br_if", depth: 1 },

    // data[i] = value
    { op: "local.get", index: dataTmp },
    { op: "local.get", index: iTmp },
    { op: "local.get", index: valTmp },
    { op: "array.set", typeIdx: arrTypeIdx },

    // i++
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

  // Return same vec ref
  fctx.body.push({ op: "local.get", index: vecTmp });
  return { kind: "ref_null", typeIdx: vecTypeIdx };
}

/**
 * TypedArray.prototype.set(source, offset?) (#1664) — copy source elements into
 * the receiver starting at `offset`, mutating the receiver's backing array in
 * place. Native WasmGC lowering so `--target wasi`/standalone modules don't fall
 * through to the generic `__extern_get`/`__extern_length` host-import path.
 *
 * `source` may be an array literal, another typed array, or an `any`/externref
 * array carrier. Statically-known arrays compile directly to their vec struct;
 * erased sources are read through the generic length/index operations without
 * casting them to a concrete vec type. When source and receiver share the same
 * element wasm type we use `array.copy`; otherwise we element-wise copy through
 * a conversion bridge so that e.g. `Float64Array.set([1,2,3])` writes correct
 * values.
 * Returns VOID_RESULT (set returns undefined) or null to bail to the fallback.
 */
function compileTypedArraySet(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
): ValType | null {
  if (callExpr.arguments.length < 1) {
    reportError(ctx, callExpr, "set requires at least 1 argument");
    return null;
  }

  // Prefer the source's concrete vec representation. An erased source still
  // needs the native TypedArray.set lane: routing it through a host method call
  // presents the WasmGC receiver as an ordinary Array view, which has no
  // TypedArray `set` method and silently leaves the destination unchanged
  // (uuid's SHA-1 input copy, #4383).
  const srcNode = callExpr.arguments[0]!;
  const srcTsType = ctx.checker.getTypeAtLocation(srcNode);
  const srcArrInfo = resolveArrayInfoForExpression(ctx, fctx, srcNode, srcTsType);
  const srcVecTypeIdx = srcArrInfo?.vecTypeIdx ?? vecTypeIdx;
  const srcArrTypeIdx = srcArrInfo?.arrTypeIdx ?? arrTypeIdx;
  const srcElemType = srcArrInfo?.elemType ?? elemType;
  const dstCarrier = inferExpressionWasmType(ctx, fctx, propAccess.expression, false);
  let externLenIdx: number | undefined;
  let externGetIdx: number | undefined;
  let unwrapForWasmIdx: number | undefined;
  let srcExtern: number | undefined;
  if (dstCarrier?.kind === "externref") {
    unwrapForWasmIdx = ensureLateImport(ctx, "__unwrap_for_wasm", [{ kind: "externref" }], [{ kind: "externref" }]);
  }
  if (!srcArrInfo) {
    addUnionImports(ctx);
    externLenIdx = ensureLateImport(ctx, "__extern_length", [{ kind: "externref" }], [{ kind: "f64" }]);
    externGetIdx = ensureLateImport(
      ctx,
      "__extern_get_idx",
      [{ kind: "externref" }, { kind: "f64" }],
      [{ kind: "externref" }],
    );
  }
  flushLateImportShifts(ctx, fctx);
  if (dstCarrier?.kind === "externref" && unwrapForWasmIdx === undefined) return null;
  if (!srcArrInfo && (externLenIdx === undefined || externGetIdx === undefined)) return null;

  const dstVec = allocLocal(fctx, `__ta_set_dvec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const dstData = allocLocal(fctx, `__ta_set_ddata_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const srcVec = allocLocal(fctx, `__ta_set_svec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: srcVecTypeIdx });
  const srcData = allocLocal(fctx, `__ta_set_sdata_${fctx.locals.length}`, {
    kind: "ref_null",
    typeIdx: srcArrTypeIdx,
  });
  const srcLen = allocLocal(fctx, `__ta_set_slen_${fctx.locals.length}`, { kind: "i32" });
  const dstLen = allocLocal(fctx, `__ta_set_dlen_${fctx.locals.length}`, { kind: "i32" });
  const offsetTmp = allocLocal(fctx, `__ta_set_off_${fctx.locals.length}`, { kind: "i32" });
  const iTmp = allocLocal(fctx, `__ta_set_i_${fctx.locals.length}`, { kind: "i32" });

  // Receiver -> vec ref, extract length (field 0) + data array (field 1).
  if (dstCarrier?.kind === "externref") {
    compileExpression(ctx, fctx, propAccess.expression, { kind: "externref" });
    fctx.body.push({ op: "call", funcIdx: unwrapForWasmIdx! });
    fctx.body.push({ op: "any.convert_extern" });
    fctx.body.push({ op: "ref.cast", typeIdx: vecTypeIdx });
  } else {
    compileExpression(ctx, fctx, propAccess.expression);
  }
  fctx.body.push({ op: "local.tee", index: dstVec });
  emitReceiverNullGuard(ctx, fctx, dstVec);
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: dstLen });
  fctx.body.push({ op: "local.get", index: dstVec });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dstData });

  // Source -> vec ref, extract length + data array. For an externref source,
  // preserve an already-boxed matching vec and otherwise copy array-like
  // values through __extern_length/__extern_get_idx.
  if (srcArrInfo) {
    compileExpression(ctx, fctx, srcNode);
    fctx.body.push({ op: "local.tee", index: srcVec });
    fctx.body.push({ op: "struct.get", typeIdx: srcVecTypeIdx, fieldIdx: 0 });
    fctx.body.push({ op: "local.set", index: srcLen });
    fctx.body.push({ op: "local.get", index: srcVec });
    fctx.body.push({ op: "struct.get", typeIdx: srcVecTypeIdx, fieldIdx: 1 });
    fctx.body.push({ op: "local.set", index: srcData });
  } else {
    srcExtern = allocLocal(fctx, `__ta_set_sext_${fctx.locals.length}`, { kind: "externref" });
    compileExpression(ctx, fctx, srcNode, { kind: "externref" });
    fctx.body.push({ op: "local.tee", index: srcExtern });
    fctx.body.push({ op: "call", funcIdx: externLenIdx! });
    fctx.body.push({ op: "i32.trunc_sat_f64_s" });
    fctx.body.push({ op: "local.set", index: srcLen });
  }

  // offset (default 0).
  if (callExpr.arguments.length >= 2) {
    if (ctx.fast) {
      compileExpression(ctx, fctx, callExpr.arguments[1]!, { kind: "i32" });
    } else {
      compileExpression(ctx, fctx, callExpr.arguments[1]!, { kind: "f64" });
      fctx.body.push({ op: "i32.trunc_sat_f64_s" });
    }
  } else {
    fctx.body.push({ op: "i32.const", value: 0 });
  }
  fctx.body.push({ op: "local.set", index: offsetTmp });

  // Spec §23.2.3.24 (%TypedArray%.prototype.set): OOB throws a catchable
  // RangeError, not an uncatchable Wasm trap (#3202 / #3335 Part 1). Emitted by
  // the relocated single-purpose module (#3358) — byte-identical to the former
  // inline block.
  emitTypedArraySetBoundsCheck(ctx, fctx, offsetTmp, srcLen, dstLen);

  if (!srcArrInfo) {
    if (srcExtern === undefined) return null;
    const elemCoerce = coercionInstrs(ctx, { kind: "externref" }, elemType, fctx);
    fctx.body.push({ op: "i32.const", value: 0 });
    fctx.body.push({ op: "local.set", index: iTmp });
    fctx.body.push({
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: iTmp },
            { op: "local.get", index: srcLen },
            { op: "i32.ge_s" },
            { op: "br_if", depth: 1 },
            { op: "local.get", index: dstData },
            { op: "local.get", index: offsetTmp },
            { op: "local.get", index: iTmp },
            { op: "i32.add" },
            { op: "local.get", index: srcExtern },
            { op: "local.get", index: iTmp },
            { op: "f64.convert_i32_s" },
            { op: "call", funcIdx: externGetIdx! },
            ...elemCoerce,
            { op: "array.set", typeIdx: arrTypeIdx },
            { op: "local.get", index: iTmp },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: iTmp },
            { op: "br", depth: 0 },
          ],
        },
      ],
    });
  } else if (srcArrTypeIdx === arrTypeIdx) {
    // Same backing array type — bulk array.copy dstData[offset..] = srcData[0..srcLen].
    emitArrayCopy(fctx, arrTypeIdx, dstData, offsetTmp, srcData, null, srcLen);
  } else {
    // Element-wise copy through an f64 bridge to convert between element types.
    fctx.body.push({ op: "i32.const", value: 0 });
    fctx.body.push({ op: "local.set", index: iTmp });
    const loopBody: Instr[] = [
      { op: "local.get", index: iTmp },
      { op: "local.get", index: srcLen },
      { op: "i32.ge_s" },
      { op: "br_if", depth: 1 },

      // dstData[offset + i] = (elemType) srcData[i]
      { op: "local.get", index: dstData },
      { op: "local.get", index: offsetTmp },
      { op: "local.get", index: iTmp },
      { op: "i32.add" },
      { op: "local.get", index: srcData },
      { op: "local.get", index: iTmp },
      ...typedArrayElemLoad(srcArrTypeIdx, srcElemType),
      ...numericElemConvert(srcElemType, elemType),
      { op: "array.set", typeIdx: arrTypeIdx },

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
  }

  return VOID_RESULT as unknown as ValType;
}

/**
 * Load one element from a vec's backing array (`array.get` + signedness).
 */
function typedArrayElemLoad(arrTypeIdx: number, elemType: ValType): Instr[] {
  const op = elemType.kind === "i8" ? "array.get_u" : elemType.kind === "i16" ? "array.get_s" : "array.get";
  return [{ op, typeIdx: arrTypeIdx }];
}

/**
 * Convert a numeric value of `from` wasm type to `to` wasm type on the stack.
 * Only handles the i32/f64 element types used by typed arrays.
 */
function numericElemConvert(from: ValType, to: ValType): Instr[] {
  if (from.kind === to.kind) return [];
  if (from.kind === "i8" && to.kind === "f64") return [{ op: "f64.convert_i32_u" }];
  if (from.kind === "i8" && to.kind === "i32") return [];
  if (from.kind === "i32" && to.kind === "i8") return [];
  if (from.kind === "f64" && to.kind === "i8") return [{ op: "i32.trunc_sat_f64_s" }];
  if (from.kind === "i32" && to.kind === "f64") return [{ op: "f64.convert_i32_s" }];
  if (from.kind === "f64" && to.kind === "i32") return [{ op: "i32.trunc_sat_f64_s" }];
  return [];
}

/**
 * `TypedArray.prototype.subarray` for a byte-backed `$__ta_view`.
 *
 * Unlike the ordinary native-vec `$__subview` path below, this retains the
 * viewed ArrayBuffer identity, accumulates the parent's byte offset, and copies
 * the runtime TypedArray kind tag. Reads and writes therefore keep aliasing the
 * parent and sibling DataView/TypedArray views even after the result passes
 * through an `any` slot.
 */
function compileTaViewSubarray(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  callExpr: ts.CallExpression,
  taViewTypeIdx: number,
): ValType | null {
  const desc = taViewDecode(ctx, taViewTypeIdx);
  if (!desc) return null;

  const viewLocal = allocLocal(fctx, `__tav_sub_recv_${fctx.locals.length}`, {
    kind: "ref_null",
    typeIdx: taViewTypeIdx,
  });
  const receiverType = compileExpression(ctx, fctx, propAccess.expression);
  if (receiverType?.kind === "externref") {
    fctx.body.push({ op: "any.convert_extern" }, { op: "ref.cast", typeIdx: taViewTypeIdx });
  } else if (
    receiverType &&
    (receiverType.kind === "ref" || receiverType.kind === "ref_null") &&
    receiverType.typeIdx !== taViewTypeIdx
  ) {
    fctx.body.push({ op: "ref.cast", typeIdx: taViewTypeIdx });
  }
  fctx.body.push({ op: "local.set", index: viewLocal });

  const lenLocal = allocLocal(fctx, `__tav_sub_len_${fctx.locals.length}`, { kind: "i32" });
  pushTaViewEffectiveLen(ctx, fctx, viewLocal, taViewTypeIdx);
  fctx.body.push({ op: "local.set", index: lenLocal });

  const beginLocal = allocLocal(fctx, `__tav_sub_begin_${fctx.locals.length}`, { kind: "i32" });
  if (callExpr.arguments.length >= 1) {
    const beginType = compileExpression(ctx, fctx, callExpr.arguments[0]!, { kind: "f64" });
    if (beginType && beginType.kind !== "i32") fctx.body.push({ op: "i32.trunc_sat_f64_s" });
  } else {
    fctx.body.push({ op: "i32.const", value: 0 });
  }
  fctx.body.push({ op: "local.set", index: beginLocal });
  emitClampIndex(fctx, beginLocal, lenLocal);

  const endLocal = allocLocal(fctx, `__tav_sub_end_${fctx.locals.length}`, { kind: "i32" });
  if (callExpr.arguments.length >= 2) {
    const endType = compileExpression(ctx, fctx, callExpr.arguments[1]!, { kind: "f64" });
    if (endType && endType.kind !== "i32") fctx.body.push({ op: "i32.trunc_sat_f64_s" });
    fctx.body.push({ op: "local.set", index: endLocal });
    emitClampIndex(fctx, endLocal, lenLocal);
  } else {
    fctx.body.push({ op: "local.get", index: lenLocal }, { op: "local.set", index: endLocal });
  }

  // length = max(end - begin, 0)
  const resultLenLocal = allocLocal(fctx, `__tav_sub_result_len_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push(
    { op: "local.get", index: endLocal },
    { op: "local.get", index: beginLocal },
    { op: "i32.sub" },
    { op: "local.tee", index: resultLenLocal },
    { op: "i32.const", value: 0 },
    { op: "i32.lt_s" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "i32.const", value: 0 },
        { op: "local.set", index: resultLenLocal },
      ],
    },
  );

  fctx.body.push(
    { op: "local.get", index: resultLenLocal },
    { op: "local.get", index: viewLocal },
    { op: "struct.get", typeIdx: taViewTypeIdx, fieldIdx: 1 }, // shared buffer
    { op: "local.get", index: viewLocal },
    { op: "struct.get", typeIdx: taViewTypeIdx, fieldIdx: 2 }, // parent byteOffset
    { op: "local.get", index: beginLocal },
  );
  if (desc.bytes !== 1) fctx.body.push({ op: "i32.const", value: desc.bytes }, { op: "i32.mul" });
  fctx.body.push(
    { op: "i32.add" },
    { op: "local.get", index: viewLocal },
    { op: "struct.get", typeIdx: taViewTypeIdx, fieldIdx: 3 }, // runtime kind
    { op: "struct.new", typeIdx: taViewTypeIdx },
  );
  return { kind: "ref_null", typeIdx: taViewTypeIdx };
}

/**
 * TypedArray.prototype.subarray(begin?, end?) (#1664 / #2357 / #47).
 *
 * In standalone / WASI mode this returns a `$__subview` that SHARES the parent's
 * backing `data` array (true aliasing per ECMA §23.2.3.30 — a write through the
 * view is visible in the parent and vice-versa). The view carries `byteOffset`
 * (element offset of `begin`) and the windowed `length`; element access on a
 * `$__subview`-typed binding is discriminated at compile time and indexes
 * `base.data[byteOffset + i]` (see compileElementAccess / compileElementAssignment).
 *
 * In JS-host mode the vec model has no shared-buffer concept on this path, so we
 * keep the historical copy (`.slice` semantics) — aliasing there is a non-goal.
 */
function compileTypedArraySubarray(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
): ValType {
  if (!noJsHost(ctx)) {
    // Host mode: keep the copy (slice semantics) — no shared buffer here.
    return compileArraySlice(ctx, fctx, propAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType);
  }

  // Standalone: build a windowing $__subview sharing the parent's data array.
  // The receiver may be a plain vec (`__vec_<elem>`) or — for a nested subarray —
  // itself a `$__subview_<elem>`; recover the element kind from either name.
  const recvStructName = ctx.typeIdxToStructName.get(vecTypeIdx);
  const elemKind = recvStructName?.replace(/^__vec_/, "").replace(/^__subview_/, "");
  if (elemKind === undefined || elemKind === recvStructName) {
    // Defensive: unknown shape — fall back to the copy path.
    return compileArraySlice(ctx, fctx, propAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType);
  }
  const subviewTypeIdx = getOrRegisterSubviewType(ctx, elemKind, elemType);

  const parentVec = allocLocal(fctx, `__sub_parent_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const lenTmp = allocLocal(fctx, `__sub_len_${fctx.locals.length}`, { kind: "i32" });
  const beginTmp = allocLocal(fctx, `__sub_b_${fctx.locals.length}`, { kind: "i32" });
  const endTmp = allocLocal(fctx, `__sub_e_${fctx.locals.length}`, { kind: "i32" });

  // Compile receiver → parent vec ref. The receiver itself may be a $__subview
  // (nested subarray); recover its base + accumulate offsets below.
  const recvType = compileExpression(ctx, fctx, propAccess.expression);
  // Nested-subarray support: if the receiver is itself a $__subview, unwrap to its
  // base vec and carry its byteOffset forward as the parent offset baseline.
  const baseOffsetTmp = allocLocal(fctx, `__sub_boff_${fctx.locals.length}`, { kind: "i32" });
  // `dataTmp` holds the SHARED backing array (parent's `data`). For a plain-vec
  // receiver it's `parent.data`; for a $__subview receiver (nested subarray) it's
  // the already-shared `recv.data`, with the offset accumulated.
  const subArrTypeIdx = getSubviewArrTypeIdx(ctx, subviewTypeIdx);
  const dataTmp = allocLocal(fctx, `__sub_data_${fctx.locals.length}`, { kind: "ref_null", typeIdx: subArrTypeIdx });
  if (recvType && (recvType.kind === "ref" || recvType.kind === "ref_null") && recvType.typeIdx === subviewTypeIdx) {
    // receiver is $__subview: data = recv.data, baseOffset = recv.byteOffset, len = recv.length
    const recvLocal = allocLocal(fctx, `__sub_recv_${fctx.locals.length}`, {
      kind: "ref_null",
      typeIdx: subviewTypeIdx,
    });
    fctx.body.push({ op: "local.set", index: recvLocal });
    fctx.body.push({ op: "local.get", index: recvLocal });
    fctx.body.push({ op: "struct.get", typeIdx: subviewTypeIdx, fieldIdx: 1 }); // shared data array
    fctx.body.push({ op: "local.set", index: dataTmp });
    fctx.body.push({ op: "local.get", index: recvLocal });
    fctx.body.push({ op: "struct.get", typeIdx: subviewTypeIdx, fieldIdx: 2 }); // byteOffset
    fctx.body.push({ op: "local.set", index: baseOffsetTmp });
    fctx.body.push({ op: "local.get", index: recvLocal });
    fctx.body.push({ op: "struct.get", typeIdx: subviewTypeIdx, fieldIdx: 0 }); // length
    fctx.body.push({ op: "local.set", index: lenTmp });
  } else {
    fctx.body.push({ op: "local.set", index: parentVec });
    emitReceiverNullGuard(ctx, fctx, parentVec);
    fctx.body.push({ op: "i32.const", value: 0 });
    fctx.body.push({ op: "local.set", index: baseOffsetTmp });
    // data = parent.data (field 1) — SHARED, no copy
    fctx.body.push({ op: "local.get", index: parentVec });
    fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
    fctx.body.push({ op: "local.set", index: dataTmp });
    // len = parent.length (field 0)
    fctx.body.push({ op: "local.get", index: parentVec });
    fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
    fctx.body.push({ op: "local.set", index: lenTmp });
  }

  // begin (default 0), §23.2.3.30: ToIntegerOrInfinity then negative-clamp to len.
  if (callExpr.arguments.length >= 1) {
    compileExpression(ctx, fctx, callExpr.arguments[0]!, { kind: "f64" });
    fctx.body.push({ op: "i32.trunc_sat_f64_s" });
  } else {
    fctx.body.push({ op: "i32.const", value: 0 });
  }
  fctx.body.push({ op: "local.set", index: beginTmp });
  emitClampIndex(fctx, beginTmp, lenTmp);

  // end (default len), same clamp.
  if (callExpr.arguments.length >= 2) {
    compileExpression(ctx, fctx, callExpr.arguments[1]!, { kind: "f64" });
    fctx.body.push({ op: "i32.trunc_sat_f64_s" });
    fctx.body.push({ op: "local.set", index: endTmp });
    emitClampIndex(fctx, endTmp, lenTmp);
  } else {
    fctx.body.push({ op: "local.get", index: lenTmp });
    fctx.body.push({ op: "local.set", index: endTmp });
  }

  // viewLen = max(end - begin, 0); push as field 0.
  // `select` returns the FIRST operand when the condition is non-zero (true), so
  // with operands [(end-begin), 0] the condition must be `(end-begin) >= 0` to keep
  // the difference and fall back to 0 when negative.
  fctx.body.push({ op: "local.get", index: endTmp });
  fctx.body.push({ op: "local.get", index: beginTmp });
  fctx.body.push({ op: "i32.sub" });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.get", index: endTmp });
  fctx.body.push({ op: "local.get", index: beginTmp });
  fctx.body.push({ op: "i32.sub" });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "i32.ge_s" });
  fctx.body.push({ op: "select" }); // max(end-begin, 0)

  // data = shared backing array (field 1).
  fctx.body.push({ op: "local.get", index: dataTmp });
  // byteOffset = baseOffset + begin (field 2) — accumulates for nested subarrays.
  fctx.body.push({ op: "local.get", index: baseOffsetTmp });
  fctx.body.push({ op: "local.get", index: beginTmp });
  fctx.body.push({ op: "i32.add" });

  fctx.body.push({ op: "struct.new", typeIdx: subviewTypeIdx });
  return { kind: "ref_null", typeIdx: subviewTypeIdx };
}

/**
 * arr.copyWithin(target, start, end?) -> copy elements within the same array, return same vec ref.
 * Mutates the array in place using array.copy.
 */
function compileArrayCopyWithin(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  _elemType: ValType,
): ValType | null {
  if (callExpr.arguments.length < 2) {
    reportError(ctx, callExpr, "copyWithin requires at least 2 arguments (target, start)");
    return null;
  }
  // copyWithin(target, start, end) — all three are index args.
  if (emitSymbolIndexArgThrow(ctx, fctx, propAccess, callExpr, [0, 1, 2])) {
    fctx.body.push({ op: "unreachable" });
    return { kind: "ref_null", typeIdx: vecTypeIdx };
  }

  const vecTmp = allocLocal(fctx, `__arr_cw_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const dataTmp = allocLocal(fctx, `__arr_cw_data_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const lenTmp = allocLocal(fctx, `__arr_cw_len_${fctx.locals.length}`, { kind: "i32" });
  const targetTmp = allocLocal(fctx, `__arr_cw_tgt_${fctx.locals.length}`, { kind: "i32" });
  const startTmp = allocLocal(fctx, `__arr_cw_s_${fctx.locals.length}`, { kind: "i32" });
  const endTmp = allocLocal(fctx, `__arr_cw_e_${fctx.locals.length}`, { kind: "i32" });
  const countTmp = allocLocal(fctx, `__arr_cw_cnt_${fctx.locals.length}`, { kind: "i32" });

  // Compile receiver -> vec ref
  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.tee", index: vecTmp });
  emitReceiverNullGuard(ctx, fctx, vecTmp);

  // Extract length
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenTmp });

  // Extract data
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataTmp });

  // target arg -- clamp negative
  if (ctx.fast) {
    compileExpression(ctx, fctx, callExpr.arguments[0]!, { kind: "i32" });
  } else {
    compileExpression(ctx, fctx, callExpr.arguments[0]!, { kind: "f64" });
    fctx.body.push({ op: "i32.trunc_sat_f64_s" });
  }
  fctx.body.push({ op: "local.set", index: targetTmp });
  emitClampIndex(fctx, targetTmp, lenTmp);

  // start arg -- clamp negative
  if (ctx.fast) {
    compileExpression(ctx, fctx, callExpr.arguments[1]!, { kind: "i32" });
  } else {
    compileExpression(ctx, fctx, callExpr.arguments[1]!, { kind: "f64" });
    fctx.body.push({ op: "i32.trunc_sat_f64_s" });
  }
  fctx.body.push({ op: "local.set", index: startTmp });
  emitClampIndex(fctx, startTmp, lenTmp);

  // end arg (default: length) -- clamp negative
  // Spec §23.1.3.4 step 11: if end is undefined, use len; else ToInteger(end).
  // Treat statically-`undefined` arguments (literal `undefined` / `void 0`) as missing,
  // because once coerced to f64 we cannot distinguish them from `NaN` (which spec says → 0).
  const cwEndArg = callExpr.arguments.length >= 3 ? callExpr.arguments[2]! : undefined;
  const cwEndIsUndef =
    cwEndArg !== undefined &&
    ((ts.isIdentifier(cwEndArg) && cwEndArg.text === "undefined") || ts.isVoidExpression(cwEndArg));
  if (cwEndArg !== undefined && !cwEndIsUndef) {
    if (ctx.fast) {
      compileExpression(ctx, fctx, cwEndArg, { kind: "i32" });
    } else {
      compileExpression(ctx, fctx, cwEndArg, { kind: "f64" });
      fctx.body.push({ op: "i32.trunc_sat_f64_s" });
    }
  } else {
    fctx.body.push({ op: "local.get", index: lenTmp });
  }
  fctx.body.push({ op: "local.set", index: endTmp });
  emitClampIndex(fctx, endTmp, lenTmp);

  // count = max(0, min(end - start, len - target))
  fctx.body.push({ op: "local.get", index: endTmp });
  fctx.body.push({ op: "local.get", index: startTmp });
  fctx.body.push({ op: "i32.sub" });
  fctx.body.push({ op: "local.get", index: lenTmp });
  fctx.body.push({ op: "local.get", index: targetTmp });
  fctx.body.push({ op: "i32.sub" });
  // select min: if (end-start) < (len-target) then (end-start) else (len-target)
  fctx.body.push({ op: "local.get", index: endTmp });
  fctx.body.push({ op: "local.get", index: startTmp });
  fctx.body.push({ op: "i32.sub" });
  fctx.body.push({ op: "local.get", index: lenTmp });
  fctx.body.push({ op: "local.get", index: targetTmp });
  fctx.body.push({ op: "i32.sub" });
  fctx.body.push({ op: "i32.lt_s" });
  fctx.body.push({ op: "select" });
  fctx.body.push({ op: "local.set", index: countTmp });
  emitClampNonNeg(fctx, countTmp);

  // (#3201 write-path) On a SPARSE array (logical `.length` beyond the WasmGC
  // backing via `a.length = N`) both the source `[start, start+count)` and the
  // destination `[target, target+count)` ranges — clamped to the LOGICAL length
  // — can run past `array.len(data)`, so the in-place `array.copy` below TRAPS
  // ("array element access out of bounds"). Grow the backing to the logical
  // length first (target/start/end are all clamped to `len`, so
  // `target+count ≤ len` and `start+count ≤ len`); the move then lands
  // in-bounds. Standalone/WASI-gated (host/gc byte-identical); dense receiver ⇒
  // runtime no-op.
  if (ctx.standalone || ctx.wasi) {
    emitEnsureBackingCapacity(fctx, vecTmp, dataTmp, vecTypeIdx, arrTypeIdx, lenTmp);
  }

  // array.copy data[target..target+count] = data[start..start+count]
  emitArrayCopy(fctx, arrTypeIdx, dataTmp, targetTmp, dataTmp, startTmp, countTmp);

  // Return same vec ref
  fctx.body.push({ op: "local.get", index: vecTmp });
  return { kind: "ref_null", typeIdx: vecTypeIdx };
}

/**
 * arr.lastIndexOf(value, fromIndex?) -> reverse linear scan, return index or -1.
 */
function compileArrayLastIndexOf(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
): ValType | null {
  const vecTmp = allocLocal(fctx, `__arr_liof_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const dataTmp = allocLocal(fctx, `__arr_liof_data_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const iTmp = allocLocal(fctx, `__arr_liof_i_${fctx.locals.length}`, { kind: "i32" });
  // Packed i8/i16 elements load (and compare) as i32 — never store the raw
  // packed type in a local (#2648).
  const valType = unpackedElemType(elemType);
  const valTmp = allocLocal(fctx, `__arr_liof_val_${fctx.locals.length}`, valType);

  // Compile receiver -> vec ref
  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.tee", index: vecTmp });
  emitReceiverNullGuard(ctx, fctx, vecTmp);

  // Extract length
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  const lenTmp = allocLocal(fctx, `__arr_liof_len_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "local.set", index: lenTmp });

  if (callExpr.arguments.length >= 2) {
    // fromIndex provided -- clamp negative and clamp to length - 1
    // (#3201) §23.1.3.20 step 3: if len is 0, return -1 BEFORE step 4's
    // ToIntegerOrInfinity(fromIndex) — a throwing `valueOf` on the fromIndex
    // object must NOT be observed on an empty array
    // (lastIndexOf/length-zero-returns-minus-one.js). Same splice-into-guard
    // pattern as compileArrayIndexOf: the spliced instrs are immediately
    // re-embedded in fctx.body (nested arms ARE walked by
    // flushLateImportShifts), so no detached-array funcIdx staleness. The
    // len==0 arm sets iTmp to -1 (the same value the no-fromIndex default
    // `len - 1` yields on an empty array), so the reverse loop never runs.
    const guardStart = fctx.body.length;
    if (ctx.fast) {
      compileExpression(ctx, fctx, callExpr.arguments[1]!, { kind: "i32" });
    } else {
      compileExpression(ctx, fctx, callExpr.arguments[1]!, { kind: "f64" });
      fctx.body.push({ op: "i32.trunc_sat_f64_s" });
    }
    fctx.body.push({ op: "local.set", index: iTmp });
    // If negative, add length: if (i < 0) i = len + i
    fctx.body.push({ op: "local.get", index: iTmp });
    fctx.body.push({ op: "i32.const", value: 0 });
    fctx.body.push({ op: "i32.lt_s" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: lenTmp },
        { op: "local.get", index: iTmp },
        { op: "i32.add" },
        { op: "local.set", index: iTmp },
      ],
    });
    // Clamp to len - 1
    fctx.body.push({ op: "local.get", index: iTmp });
    fctx.body.push({ op: "local.get", index: lenTmp });
    fctx.body.push({ op: "i32.const", value: 1 });
    fctx.body.push({ op: "i32.sub" });
    fctx.body.push({ op: "i32.gt_s" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: lenTmp },
        { op: "i32.const", value: 1 },
        { op: "i32.sub" },
        { op: "local.set", index: iTmp },
      ],
    });
    const guarded = fctx.body.splice(guardStart);
    fctx.body.push({ op: "local.get", index: lenTmp });
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: guarded,
      else: [
        { op: "i32.const", value: -1 },
        { op: "local.set", index: iTmp },
      ],
    });
  } else {
    // Default: length - 1
    fctx.body.push({ op: "local.get", index: lenTmp });
    fctx.body.push({ op: "i32.const", value: 1 });
    fctx.body.push({ op: "i32.sub" });
    fctx.body.push({ op: "local.set", index: iTmp });
  }

  // Extract data
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataTmp });

  // (#3201) A sparse array (logical `.length` > physical backing) starts the
  // reverse scan at `len-1`, beyond the backing array — the first `data[i]`
  // read TRAPS ("array element access out of bounds"). Per §23.1.3.20
  // (HasProperty-driven) the absent top indices are SKIPPED, so clamp the
  // start index down to `array.len(data)-1`. Non-sparse vecs are unaffected
  // (backing capacity ≥ length ⇒ the clamp is a no-op).
  fctx.body.push({ op: "local.get", index: iTmp });
  fctx.body.push({ op: "local.get", index: dataTmp });
  fctx.body.push({ op: "array.len" });
  fctx.body.push({ op: "i32.const", value: 1 });
  fctx.body.push({ op: "i32.sub" });
  fctx.body.push({ op: "i32.gt_s" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [
      { op: "local.get", index: dataTmp },
      { op: "array.len" },
      { op: "i32.const", value: 1 },
      { op: "i32.sub" },
      { op: "local.set", index: iTmp },
    ],
  });

  // Compile search value. (#5121 S1) Absent ⇒ search for `undefined`
  // (§23.1.3.20 step 1) — see the twin comment in `compileArrayIndexOf` for the
  // swallowed-diagnostic collapse this replaces.
  const liofSearchArg = callExpr.arguments[0];
  if (liofSearchArg !== undefined) {
    compileExpression(ctx, fctx, liofSearchArg, valType);
    fctx.body.push({ op: "local.set", index: valTmp });
  } else if (emitIndexOfAbsentSearchValue(ctx, fctx, valType, valTmp)) {
    fctx.body.push(ctx.fast ? { op: "i32.const", value: -1 } : { op: "f64.const", value: -1 });
    return ctx.fast ? { kind: "i32" } : { kind: "f64" };
  }

  // (#2648) View-name-driven signedness for the packed i8/i16 element load.
  const getOp = elemGetOp(elemType, typedArraySearchSignedness(ctx, propAccess.expression));

  // For externref elements, use __host_eq (JS Strict Equality, §7.2.16) so
  // object identity, cross-type, and string comparisons follow spec. The
  // wasm:js-string `equals` builtin coerces both operands to strings, which
  // mis-matches object/boolean/number elements (#786).
  // For ref/ref_null elements, use ref.eq for reference identity comparison.
  let liofEqInstrs: Instr[];
  if (elemType.kind === "externref") {
    // (#2719) Standalone/WASI route element Strict Equality through the pure-Wasm
    // `__extern_strict_eq` helper instead of the unsatisfiable `__host_eq` import;
    // host/gc mode keeps the import. Mirrors indexOf / the `.call(...)` form.
    const nativeCmp = ctx.standalone || ctx.wasi;
    const cmpIdx = nativeCmp
      ? ensureExternStrictEqHelper(ctx)
      : ensureLateImport(ctx, "__host_eq", [{ kind: "externref" }, { kind: "externref" }], [{ kind: "i32" }]);
    flushLateImportShifts(ctx, fctx);
    const cmpName = nativeCmp ? "__extern_strict_eq" : "__host_eq";
    const finalCmpIdx = ctx.funcMap.get(cmpName) ?? cmpIdx;
    if (finalCmpIdx === undefined) {
      reportError(ctx, callExpr, "lastIndexOf: failed to bind element equality helper");
      return null;
    }
    liofEqInstrs = [{ op: "call", funcIdx: finalCmpIdx }];
  } else if (elemType.kind === "ref" || elemType.kind === "ref_null") {
    // #2036 — native-string elements compare by content (§7.2.16), not identity.
    liofEqInstrs = nativeStringElementEqInstrs(ctx, fctx, elemType) ?? [{ op: "ref.eq" }];
  } else {
    const eqOp = elemType.kind === "f64" ? "f64.eq" : "i32.eq";
    liofEqInstrs = [{ op: eqOp }];
  }

  // Use a result local instead of `return` to avoid returning from the
  // enclosing function when lastIndexOf is inlined.
  const liofResType: ValType = ctx.fast ? { kind: "i32" } : { kind: "f64" };
  const liofResTmp = allocLocal(fctx, `__arr_liof_res_${fctx.locals.length}`, liofResType);
  if (ctx.fast) {
    fctx.body.push({ op: "i32.const", value: -1 });
  } else {
    fctx.body.push({ op: "f64.const", value: -1 });
  }
  fctx.body.push({ op: "local.set", index: liofResTmp });

  // (#2001 S1 — lastIndexOf hole-SKIP DEFERRED, see the S2 boundary note.) Same
  // as indexOf: §23.1.3.20 uses HasProperty (a clean hole should be skipped),
  // but test262's sparse-hole lastIndexOf tests rely on prototype-inherited
  // indices we can't model, so keep the S1 `$Hole → undefined` map (net-0).
  let liofHoleMap: Instr[] = [];
  if (ctx.usesArrayHoles && elemType.kind === "externref") {
    ensureGetUndefined(ctx);
    flushLateImportShifts(ctx, fctx);
    liofHoleMap = holeToUndefinedInstrs(ctx, fctx);
  }

  // Loop: while (i >= 0) { if data[i] == val, store i and break; i--; }
  const loopBody: Instr[] = [
    // if (i < 0) break
    { op: "local.get", index: iTmp },
    { op: "i32.const", value: 0 },
    { op: "i32.lt_s" },
    { op: "br_if", depth: 1 },

    // if (data[i] == val) store result and break
    { op: "local.get", index: dataTmp },
    { op: "local.get", index: iTmp },
    { op: getOp, typeIdx: arrTypeIdx },
    ...liofHoleMap,
    { op: "local.get", index: valTmp },
    ...liofEqInstrs,
    {
      op: "if",
      blockType: { kind: "empty" },
      then: ctx.fast
        ? [
            { op: "local.get", index: iTmp },
            { op: "local.set", index: liofResTmp },
            { op: "br", depth: 2 }, // break out of block
          ]
        : [
            { op: "local.get", index: iTmp },
            { op: "f64.convert_i32_s" },
            { op: "local.set", index: liofResTmp },
            { op: "br", depth: 2 }, // break out of block
          ],
    },

    // i--
    { op: "local.get", index: iTmp },
    { op: "i32.const", value: 1 },
    { op: "i32.sub" },
    { op: "local.set", index: iTmp },
    { op: "br", depth: 0 },
  ];

  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [{ op: "loop", blockType: { kind: "empty" }, body: loopBody }],
  });

  fctx.body.push({ op: "local.get", index: liofResTmp });

  if (ctx.fast) {
    return { kind: "i32" };
  }
  return { kind: "f64" };
}

/**
 * (#3363) Standalone-native depth-1 flatten of a statically-typed HOMOGENEOUS
 * nested array `T[][]` — the common `[[…],[…]].flat()` case. `elemType` is the
 * OUTER array's element type; when it resolves to a ref to an inner `$vec`
 * struct (`{ len, data }`), each inner vec's elements are copied contiguously
 * into a fresh result vec of the inner element kind (a straight concatenation,
 * which is exactly a depth-1 flatten of an all-array array). Returns the result
 * ValType on success, or `null` when the receiver is not a recognizable nested
 * vec (the caller then refuses loudly — no silent wrong value).
 *
 * Only the DEFAULT depth (no `depth` argument) is handled; an explicit depth,
 * deeper recursion, and heterogeneous array/scalar unions stay deferred to the
 * larger #2717 follow-up.
 */
/**
 * (#2717) Precondition for the native depth-1 flatten: the outer vec's element
 * must be a `ref`/`ref_null` to an INNER vec struct (an array-of-arrays), and
 * that inner vec must resolve to a concrete backing array type. Returns the
 * inner vec + array type indices, or null when the shape is not a homogeneous
 * nested array (scalar / externref / mixed elements → the caller falls back).
 */
function canFlattenVecElem(
  ctx: CodegenContext,
  elemType: ValType,
): { innerVecTypeIdx: number; innerArrTypeIdx: number } | null {
  if (elemType.kind !== "ref" && elemType.kind !== "ref_null") return null;
  const innerVecTypeIdx = (elemType as { typeIdx?: number }).typeIdx;
  if (innerVecTypeIdx === undefined) return null;
  const innerArrTypeIdx = getArrTypeIdxFromVec(ctx, innerVecTypeIdx);
  if (innerArrTypeIdx < 0) return null;
  const innerArrDef = ctx.mod.types[innerArrTypeIdx];
  if (!innerArrDef || innerArrDef.kind !== "array") return null;
  return { innerVecTypeIdx, innerArrTypeIdx };
}

/**
 * (#2717) Emit a native depth-1 flatten of an outer vec-of-vecs. The outer vec
 * value must be BOTH on the Wasm stack AND stored in the `outerVec` local (the
 * caller tees it and, for a user receiver, null-guards it first). Consumes the
 * stack value; returns a fresh inner-element vec holding every non-null inner
 * vec's elements concatenated in order.
 *
 * Shared by `Array.prototype.flat()` (outer vec = the receiver) and the
 * `Array.prototype.flatMap()` native arm (outer vec = the native `map` result).
 */
function emitFlattenDepth1FromVec(
  ctx: CodegenContext,
  fctx: FunctionContext,
  outerVec: number,
  vecTypeIdx: number,
  arrTypeIdx: number,
  innerVecTypeIdx: number,
  innerArrTypeIdx: number,
): ValType {
  const outerData = allocLocal(fctx, `__arr_flat_od_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const outerLen = allocLocal(fctx, `__arr_flat_ol_${fctx.locals.length}`, { kind: "i32" });
  const total = allocLocal(fctx, `__arr_flat_tot_${fctx.locals.length}`, { kind: "i32" });
  const iTmp = allocLocal(fctx, `__arr_flat_i_${fctx.locals.length}`, { kind: "i32" });
  const inner = allocLocal(fctx, `__arr_flat_in_${fctx.locals.length}`, { kind: "ref_null", typeIdx: innerVecTypeIdx });
  const innerLen = allocLocal(fctx, `__arr_flat_il_${fctx.locals.length}`, { kind: "i32" });
  const innerData = allocLocal(fctx, `__arr_flat_id_${fctx.locals.length}`, {
    kind: "ref_null",
    typeIdx: innerArrTypeIdx,
  });
  const resultData = allocLocal(fctx, `__arr_flat_rd_${fctx.locals.length}`, {
    kind: "ref_null",
    typeIdx: innerArrTypeIdx,
  });
  const pos = allocLocal(fctx, `__arr_flat_pos_${fctx.locals.length}`, { kind: "i32" });

  // outer vec is on the stack (also in `outerVec`): unpack len/data.
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: outerLen });
  fctx.body.push({ op: "local.get", index: outerVec });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: outerData });

  // Pass 1: total = Σ (non-null) inner.length
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: total });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: iTmp });
  const pass1: Instr[] = [
    { op: "local.get", index: iTmp },
    { op: "local.get", index: outerLen },
    { op: "i32.ge_s" },
    { op: "br_if", depth: 1 },
    // inner = outerData[i]
    { op: "local.get", index: outerData },
    { op: "local.get", index: iTmp },
    { op: "array.get", typeIdx: arrTypeIdx },
    { op: "local.set", index: inner },
    // if inner != null: total += inner.len
    { op: "local.get", index: inner },
    { op: "ref.is_null" },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: total },
        { op: "local.get", index: inner },
        { op: "ref.as_non_null" },
        { op: "struct.get", typeIdx: innerVecTypeIdx, fieldIdx: 0 },
        { op: "i32.add" },
        { op: "local.set", index: total },
      ],
      else: [],
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
    body: [{ op: "loop", blockType: { kind: "empty" }, body: pass1 }],
  });

  // resultData = new inner-element[total]
  fctx.body.push({ op: "local.get", index: total });
  fctx.body.push({ op: "array.new_default", typeIdx: innerArrTypeIdx });
  fctx.body.push({ op: "local.set", index: resultData });

  // Pass 2: copy each inner vec's elements contiguously into resultData.
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: pos });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: iTmp });
  // When inner != null: unpack len/data, copy its elements into resultData[pos..],
  // then advance pos by inner.length.
  const copyInner: Instr[] = [
    // innerLen = inner.len; innerData = inner.data
    { op: "local.get", index: inner },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: innerVecTypeIdx, fieldIdx: 0 },
    { op: "local.set", index: innerLen },
    { op: "local.get", index: inner },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: innerVecTypeIdx, fieldIdx: 1 },
    { op: "local.set", index: innerData },
    // resultData[pos .. pos+innerLen) = innerData[0 .. innerLen)
    { op: "local.get", index: resultData },
    { op: "local.get", index: pos },
    { op: "local.get", index: innerData },
    { op: "i32.const", value: 0 },
    { op: "local.get", index: innerLen },
    { op: "array.copy", dstTypeIdx: innerArrTypeIdx, srcTypeIdx: innerArrTypeIdx },
    // pos += innerLen
    { op: "local.get", index: pos },
    { op: "local.get", index: innerLen },
    { op: "i32.add" },
    { op: "local.set", index: pos },
  ];
  const pass2: Instr[] = [
    { op: "local.get", index: iTmp },
    { op: "local.get", index: outerLen },
    { op: "i32.ge_s" },
    { op: "br_if", depth: 1 },
    // inner = outerData[i]
    { op: "local.get", index: outerData },
    { op: "local.get", index: iTmp },
    { op: "array.get", typeIdx: arrTypeIdx },
    { op: "local.set", index: inner },
    // if inner != null: copy its elements
    { op: "local.get", index: inner },
    { op: "ref.is_null" },
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: copyInner, else: [] },
    // i++
    { op: "local.get", index: iTmp },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.set", index: iTmp },
    { op: "br", depth: 0 },
  ];
  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [{ op: "loop", blockType: { kind: "empty" }, body: pass2 }],
  });

  // return struct.new $innerVec(total, resultData)
  fctx.body.push({ op: "local.get", index: total });
  fctx.body.push({ op: "local.get", index: resultData });
  fctx.body.push({ op: "ref.as_non_null" });
  fctx.body.push({ op: "struct.new", typeIdx: innerVecTypeIdx });
  return { kind: "ref_null", typeIdx: innerVecTypeIdx };
}

/**
 * (#3363) Native depth-1 homogeneous nested-array flatten for `arr.flat()` on
 * the host-free lanes. Default depth only (an explicit `depth` argument falls
 * through to the loud refusal); the outer element must be a nested vec.
 */
function tryCompileArrayFlatNativeDepth1(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
): ValType | null {
  // Default depth only — an explicit `depth` argument falls through to refusal.
  if (callExpr.arguments.length > 0) return null;
  const pre = canFlattenVecElem(ctx, elemType);
  if (!pre) return null;

  const outerVec = allocLocal(fctx, `__arr_flat_ov_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  // receiver -> outerVec (null-guarded), leaving the vec on the stack for the flatten.
  compileExpression(ctx, fctx, propAccess.expression);
  fctx.body.push({ op: "local.tee", index: outerVec });
  emitReceiverNullGuard(ctx, fctx, outerVec);
  return emitFlattenDepth1FromVec(
    ctx,
    fctx,
    outerVec,
    vecTypeIdx,
    arrTypeIdx,
    pre.innerVecTypeIdx,
    pre.innerArrTypeIdx,
  );
}

/**
 * (#2717) Native `arr.flatMap(cb, thisArg?)` for the host-free lanes.
 *
 * `flatMap(cb)` is spec-equivalent to `map(cb).flat(1)`, so we compile the native
 * `map` directly (its arg layout — arg0 = cb, arg1 = thisArg — matches flatMap's)
 * and dispatch on the RESULT vec's element type — the ground truth for what the
 * callback returned:
 *   - element is a nested vec (callback returned arrays) → depth-1 flatten;
 *   - element is a concrete scalar / non-array ref (callback returned a scalar or
 *     a plain object) → `flatMap` ≡ `map` (a depth-1 flatten of non-arrays is the
 *     identity), so the map result IS the answer;
 *   - element is `externref`/`anyref` (dynamic — could be an array at runtime) →
 *     drop + refuse loudly (a runtime-heterogeneous flatten is out of scope; never
 *     a silent-wrong result), per the #2711 policy.
 *
 * Compiling `map` unconditionally (rather than into a throwaway buffer) mirrors
 * the working `map(cb).flat()` codegen exactly; only the rare dynamic-return case
 * leaves dead map code before the caller's `unreachable`, which is well-typed.
 */
function tryCompileFlatMapNative(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
): ValType | null {
  if (callExpr.arguments.length < 1) return null; // flatMap requires a callback

  const mapType = compileArrayMap(ctx, fctx, propAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType);
  const speciesResult = flatMapSpeciesResult(ctx, mapType, callExpr.arguments[0]!);
  if (speciesResult) return speciesResult;
  if (!mapType || (mapType.kind !== "ref" && mapType.kind !== "ref_null")) {
    // map couldn't type its result; the caller's unreachable keeps the body valid.
    return null;
  }
  const mapVecTypeIdx = (mapType as { typeIdx?: number }).typeIdx;
  if (mapVecTypeIdx === undefined) return null;
  const mapArrTypeIdx = getArrTypeIdxFromVec(ctx, mapVecTypeIdx);
  const mapArrDef = mapArrTypeIdx >= 0 ? ctx.mod.types[mapArrTypeIdx] : undefined;
  const mapElemType = mapArrDef && mapArrDef.kind === "array" ? mapArrDef.element : undefined;

  // Callback returned arrays → flatten the map result depth-1.
  const pre = mapElemType ? canFlattenVecElem(ctx, mapElemType) : null;
  if (pre) {
    const mapVec = allocLocal(fctx, `__arr_flatmap_mv_${fctx.locals.length}`, {
      kind: "ref_null",
      typeIdx: mapVecTypeIdx,
    });
    fctx.body.push({ op: "local.tee", index: mapVec });
    return emitFlattenDepth1FromVec(
      ctx,
      fctx,
      mapVec,
      mapVecTypeIdx,
      mapArrTypeIdx,
      pre.innerVecTypeIdx,
      pre.innerArrTypeIdx,
    );
  }

  // Dynamic element (externref/anyref) — could be an array at runtime; a native
  // depth-1 flatten would need per-element runtime IsArray. Out of scope → drop
  // the map result and refuse loudly.
  if (mapElemType && (mapElemType.kind === "externref" || mapElemType.kind === "anyref")) {
    fctx.body.push({ op: "drop" });
    return null;
  }

  // Concrete non-array element (scalar or plain-object ref): flatMap ≡ map.
  return mapType;
}

/**
 * Compile arr.flat(depth?) — delegates to __array_flat host import (#1136).
 * Converts WasmGC vec receiver to externref, passes depth arg, returns externref.
 */
function compileArrayFlat(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
): ValType | null {
  // (#2717) `flat` has no host-import Wasm-native arm — it delegates to the host
  // `__array_flat` import. Under `--target standalone`/`wasi` there is no JS host
  // to satisfy that import, so emitting it produces a module that traps at
  // instantiation. Per the #2711 fail-loud policy, refuse loudly instead of
  // emitting an unsatisfiable import.
  if (ctx.standalone || ctx.wasi) {
    // (#3363) Native depth-1 homogeneous nested-array flatten first; falls
    // through to the loud refusal below for depth args / non-nested / mixed
    // receivers (the larger recursive/heterogeneous arm stays a #2717 follow-up).
    const native = tryCompileArrayFlatNativeDepth1(ctx, fctx, propAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType);
    if (native) return native;
    reportError(
      ctx,
      callExpr,
      `Codegen error: Array.prototype.flat() is not yet supported in --target standalone/wasi ` +
        `(#2717) — there is no Wasm-native flatten arm and emitting the host import __array_flat ` +
        `would produce a module that traps at instantiation. Recompile without --target ` +
        `standalone, or avoid flat() in standalone/WASI code.`,
    );
    // Return a non-null type (matching the host externref result) + `unreachable`
    // so the #1919 speculative wrapper COMMITS instead of rolling back: a rolled-
    // back null would discard the diagnostic (truncate `ctx.errors`) and emit a
    // silent default, so the standalone build would compile to a wrong value
    // (e.g. `flat().length === 0`) instead of failing loud. The `unreachable`
    // keeps the body well-typed; the recorded error fails the compile.
    fctx.body.push({ op: "unreachable" });
    return { kind: "externref" };
  }

  // __array_flat(receiver: externref, depth: externref) -> externref
  const flatIdx = ensureLateImport(
    ctx,
    "__array_flat",
    [{ kind: "externref" }, { kind: "externref" }],
    [{ kind: "externref" }],
  );
  flushLateImportShifts(ctx, fctx);
  if (flatIdx === undefined) return null;

  // Compile receiver as externref
  const recvType = compileExpression(ctx, fctx, propAccess.expression);
  if (recvType && recvType.kind !== "externref") {
    fctx.body.push({ op: "extern.convert_any" });
  }

  // Compile depth argument (or push undefined)
  if (callExpr.arguments.length > 0) {
    const depthType = compileExpression(ctx, fctx, callExpr.arguments[0]!);
    if (depthType && depthType.kind !== "externref") {
      coerceType(ctx, fctx, depthType, { kind: "externref" });
    } else if (!depthType) {
      fctx.body.push({ op: "ref.null.extern" });
    }
  } else {
    fctx.body.push({ op: "ref.null.extern" });
  }

  fctx.body.push({ op: "call", funcIdx: flatIdx });
  return { kind: "externref" };
}

/**
 * Compile arr.flatMap(callback, thisArg?) — delegates to __array_flatMap host import (#1136).
 * Converts WasmGC vec receiver to externref, passes callback and optional thisArg, returns externref.
 */
function compileArrayFlatMap(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
): ValType | null {
  // §23.1.3.11 step 3: IsCallable(mapperFunction) is false → throw TypeError,
  // BEFORE any flatten work. Mirrors map/filter/forEach; covers the missing
  // callback (`[].flatMap()`) and known-non-callable args (`{}`, `0`, `null`,
  // `Symbol()`, …). Placed above the standalone arm so both lanes get it.
  if (emitCallbackTypeCheck(ctx, fctx, callExpr, "Array.prototype.flatMap")) {
    fctx.body.push({ op: "unreachable" });
    return { kind: "externref" };
  }
  if (callExpr.arguments.length < 1) return null; // flatMap requires a callback

  // (#2717) On the host-free lanes `flatMap` has no host `__array_flatMap` to
  // satisfy. `flatMap(cb)` ≡ `map(cb).flat(1)`, so try the native arm first
  // (reuses the native `map` + the #3363 depth-1 flatten); it applies when the
  // callback provably returns arrays. Otherwise fall through to the loud refusal
  // below (scalar / union / externref returns), per the #2711 fail-loud policy.
  // Host/gc mode is unchanged — it keeps the fast `__array_flatMap` import path.
  if (ctx.standalone || ctx.wasi) {
    const native = tryCompileFlatMapNative(ctx, fctx, propAccess, callExpr, vecTypeIdx, arrTypeIdx, elemType);
    if (native) return native;
    reportError(
      ctx,
      callExpr,
      `Codegen error: Array.prototype.flatMap() with a non-array-returning callback is not yet ` +
        `supported in --target standalone/wasi (#2717) — the native arm handles callbacks that ` +
        `return arrays (flatMap ≡ map+flat(1)); scalar/union/dynamic returns would need a ` +
        `runtime-heterogeneous flatten. Emitting the host import __array_flatMap would produce a ` +
        `module that traps at instantiation. Recompile without --target standalone, or have the ` +
        `flatMap callback return an array.`,
    );
    // Non-null type + `unreachable` so the #1919 speculative wrapper commits and
    // the diagnostic is not rolled back into a silent default (see compileArrayFlat).
    fctx.body.push({ op: "unreachable" });
    return { kind: "externref" };
  }

  // __array_flatMap(receiver: externref, fn: externref, thisArg: externref) -> externref
  const flatMapIdx = ensureLateImport(
    ctx,
    "__array_flatMap",
    [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
    [{ kind: "externref" }],
  );
  flushLateImportShifts(ctx, fctx);
  if (flatMapIdx === undefined) return null;

  // Compile receiver as externref
  const recvType = compileExpression(ctx, fctx, propAccess.expression);
  if (recvType && recvType.kind !== "externref") {
    fctx.body.push({ op: "extern.convert_any" });
  }

  // Compile callback as externref
  const cbType = compileExpression(ctx, fctx, callExpr.arguments[0]!);
  if (cbType && cbType.kind !== "externref") {
    coerceType(ctx, fctx, cbType, { kind: "externref" });
  } else if (!cbType) {
    fctx.body.push({ op: "ref.null.extern" });
  }

  // Compile thisArg (or push undefined)
  if (callExpr.arguments.length > 1) {
    const thisArgType = compileExpression(ctx, fctx, callExpr.arguments[1]!);
    if (thisArgType && thisArgType.kind !== "externref") {
      coerceType(ctx, fctx, thisArgType, { kind: "externref" });
    } else if (!thisArgType) {
      fctx.body.push({ op: "ref.null.extern" });
    }
  } else {
    fctx.body.push({ op: "ref.null.extern" });
  }

  fctx.body.push({ op: "call", funcIdx: flatMapIdx });
  return { kind: "externref" };
}

// Register the emitBoundsCheckedArrayGet delegate so closures.ts (and any
// other module) can call it via shared.ts without depending on array-methods.ts.
registerEmitBoundsCheckedArrayGet(emitBoundsCheckedArrayGet);
