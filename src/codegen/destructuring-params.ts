// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Function parameter destructuring — object and array binding patterns.
 *
 * Extracted from codegen/index.ts (#1013).
 */
import { ts } from "../ts-api.js";
import type { Instr, ValType } from "../ir/types.js";
import { popBody, pushBody } from "./context/bodies.js";
import { reportSilentFallback } from "./fallback-telemetry.js";
import { allocLocal, getLocalType } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { shiftLateImportIndices } from "./expressions/late-imports.js";
import {
  addUnionImports,
  ensureLetConstBindingPatternTdzFlags,
  ensureStructForType,
  resolveWasmType,
} from "./index.js";
import {
  isUndefWidenedBindingElement,
  resolveBindingElementType,
  undefinedPreservingBindingSourceType,
} from "../checker/type-mapper.js";
import { boxToAny, UNDEF_F64_BITS } from "./value-tags.js"; // (#3315)
import { addImport, addStringConstantGlobal, ensureExnTag } from "./registry/imports.js";
import { emitWasiErrorConstructor } from "./registry/error-types.js";
import { usesNativeJsErrors } from "./js-errors.js";
import { compileObjectLiteralAsExternref } from "./literals.js";
// (#3178) done/value reads on native IteratorResult structs — late-bound via
// shared.ts (a static member-get-dispatch.ts import here is an eval-time cycle).
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { ensureExternRestObject } from "./object-runtime.js";
import { emitLocalTdzInit } from "./statements/tdz.js";
import { addFuncType, getArrTypeIdxFromVec, getOrRegisterVecType } from "./registry/types.js";
import { holeToUndefinedInstrs } from "./array-holes.js"; // (#2001 S1)
import {
  emitIsUndefinedSingletonExternAt,
  ensureAnyFromExternHelper,
  ensureAnyHelpers,
  isAnyValue,
  undefinedExternInstrs,
  undefinedSingletonActive,
} from "./any-helpers.js"; // (#2106 S1)
import {
  coerceType,
  compileExpression,
  emitBoundsCheckedArrayGet,
  emitDefaultValueCheck,
  emitNestedBindingDefault,
  ensureBindingLocals,
  ensureLateImport,
  flushLateImportShifts,
  reserveMemberGetDispatchLate,
  valTypesMatch,
} from "./shared.js";
import { buildVecFromExternref, getVecInfo } from "./type-coercion.js";
import { ensureNativeArrayFromIterN } from "./iterator-native.js";
import { arrayIteratorOverrideGlobalIdx } from "./expressions/proto-override.js";
// (#1719 CPR-2) `arrayDstrNeedsIdentity` / `tryEmitArrayProtoIteratorReadDrive` /
// `syncDestructuredLocalsToGlobals` live in statements/destructuring.ts, which
// already imports `destructureParamArray` from here — a module cycle. ESM
// resolves it because these references are used at call time (inside
// `destructureParamArray`), never at module-init.
import {
  arrayDstrNeedsIdentity,
  syncDestructuredLocalsToGlobals,
  tryEmitArrayProtoIteratorReadDrive,
} from "./statements/destructuring.js";

/**
 * Preserve the runtime JS tag when a heterogeneous binding local uses the
 * standalone `$AnyValue` carrier but the source vector stores externrefs.
 *
 * `coerceType(externref, $AnyValue)` intentionally keeps the historical
 * tag-5 wrapper for generic dynamic values.  Array binding is different: its
 * externref element was already boxed by the literal's static type, so
 * wrapping a boxed number/boolean again turns it into a string-like tag-5
 * value.  Null also needs an explicit tag-0 box because `null` is represented
 * by a null externref at this boundary.  This is the narrow bridge used by
 * `destructureParamArray`; all other externref→AnyValue coercions retain their
 * existing policy.
 */
export function coerceArrayBindingExternrefToAnyValue(
  ctx: CodegenContext,
  fctx: FunctionContext,
  from: ValType,
  to: ValType,
): boolean {
  if (
    !ctx.unionAnyRep ||
    !(ctx.standalone || ctx.wasi) ||
    from.kind !== "externref" ||
    !isAnyValue(to, ctx) ||
    ctx.anyValueTypeIdx < 0
  ) {
    return false;
  }

  addUnionImports(ctx);
  ensureAnyHelpers(ctx);
  const honestIdx = ensureAnyFromExternHelper(ctx, { forceHonest: true });
  const nullBoxBody: Instr[] = [];
  const nullBoxed = boxToAny(ctx, { body: nullBoxBody } as FunctionContext, { kind: "externref" }, "null");
  if (honestIdx === undefined || !nullBoxed) return false;

  const sourceLocal = allocLocal(fctx, `__dparam_any_src_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: sourceLocal });
  fctx.body.push({ op: "local.get", index: sourceLocal });
  fctx.body.push({ op: "ref.is_null" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "ref_null", typeIdx: ctx.anyValueTypeIdx } },
    then: [{ op: "local.get", index: sourceLocal }, ...nullBoxBody],
    else: [
      { op: "local.get", index: sourceLocal },
      { op: "call", funcIdx: honestIdx },
    ],
  });
  return true;
}

/**
 * (#3241/#4397) Emit the native-provider object-rest CopyDataProperties
 * (ES §14.7.4), storing the fresh rest `$Object` into `restIdx`.
 *
 * Shared by every object-rest binding site (function-param rest, for-of/-await
 * loop-var rest, assignment-target rest) so they all route to the DEFINED native
 * `__extern_rest_object` (#3223) instead of the `env.__extern_rest_object` host
 * import — which both LEAKS an env:: import (breaking zero-import instantiation)
 * and, worse, is SILENTLY MISCOMPILED when the native func is already registered
 * by another rest site: the host-import call sites pass a comma-joined excluded
 * STRING, but the native helper takes an EXCLUSION OBJECT, so its
 * `__extern_has(excl, key)` membership probe reports "absent" for the string and
 * NO key is excluded (the rest object wrongly keeps the destructured keys).
 *
 * This helper builds the exclusion object (own keys = excluded property names;
 * value is the key itself — only presence matters), then invokes `emitSource`,
 * which MUST leave an **open-`$Object` externref** for the source on the stack
 * (`__object_keys` walks only the open-`$Object` hash — a CLOSED-shape struct
 * reinterpreted via `extern.convert_any` is invisible to it and yields an EMPTY
 * rest, #3222 C1; struct sources must be reified via `materializeStructAsObject`
 * inside `emitSource`). Returns `false` (caller keeps its host/gc path) if a
 * dependency is unexpectedly missing. Compatibility host-assisted builds retain
 * the historical host helper; every native-first environment uses this path.
 */
export function emitNativeObjectRest(
  ctx: CodegenContext,
  fctx: FunctionContext,
  emitSource: () => void,
  excludedKeys: string[],
  restIdx: number,
): boolean {
  const restObjIdx = ensureExternRestObject(ctx);
  const newPlainObjIdx = ctx.funcMap.get("__new_plain_object");
  const externSetIdx = ctx.funcMap.get("__extern_set");
  if (restObjIdx === undefined || newPlainObjIdx === undefined || externSetIdx === undefined) return false;
  const exclLocal = allocLocal(fctx, `__rest_excl_${fctx.locals.length}`, { kind: "externref" });
  // excl = OrdinaryObjectCreate(null)
  fctx.body.push({ op: "call", funcIdx: newPlainObjIdx });
  fctx.body.push({ op: "local.set", index: exclLocal });
  // for each excluded key: __extern_set(excl, key, key) — the value only needs
  // to be non-null so the helper's membership probe (__extern_has) reports
  // "present"; reuse the key's own externref as a cheap sentinel.
  for (const key of excludedKeys) {
    fctx.body.push({ op: "local.get", index: exclLocal });
    for (const instr of stringConstantExternrefInstrs(ctx, key)) fctx.body.push(instr);
    for (const instr of stringConstantExternrefInstrs(ctx, key)) fctx.body.push(instr);
    fctx.body.push({ op: "call", funcIdx: externSetIdx });
  }
  // rest = __extern_rest_object(source, excl)
  emitSource();
  fctx.body.push({ op: "local.get", index: exclLocal });
  fctx.body.push({ op: "call", funcIdx: restObjIdx });
  fctx.body.push({ op: "local.set", index: restIdx });
  return true;
}

/**
 * #2032 — resolve the static property key for an object binding element.
 *
 * For a plain identifier or string/numeric literal property name the key is
 * already its `.text`. For a `ComputedPropertyName` (`{ [k]: v }`) the struct
 * fast path needs a compile-time-constant string to map to a field index; we
 * recover it from the checker when the key expression has a string- or
 * numeric-literal type (the common `const k = "dyn"; { [k]: v }` case).
 *
 * Returns `undefined` when the key cannot be resolved statically — the caller
 * then reports a clear unsupported-feature error rather than silently binding
 * the zero-initialized local (the original bug: a `ComputedPropertyName` has
 * no `.text`, so `fields.findIndex` returned -1 and the binding was skipped).
 */
/**
 * (#2569) Evaluate a destructuring ComputedPropertyName expression for its SIDE
 * EFFECT (and throw propagation), discarding the resulting key. §13.15.5.3
 * BindingInitialization / 13.2.5.5 → "Evaluation of ComputedPropertyName" runs
 * the expression as part of destructuring, so `{ [thrower()]: x }` must run
 * `thrower()` (and propagate its throw) even when the static fast-path can't map
 * the runtime key to a struct field. Compiles the key expression and drops
 * whatever it leaves on the stack (the value type is irrelevant — we only need
 * the effect); a `null`/`VOID_RESULT` producer leaves nothing to drop.
 */
function emitComputedKeyForEffect(ctx: CodegenContext, fctx: FunctionContext, keyExpr: ts.Expression): void {
  const t = compileExpression(ctx, fctx, keyExpr);
  // Drop only when the expression left a concrete value on the stack. A `null`
  // result (no value) or a `VOID_RESULT` sentinel (a void-typed expression, e.g.
  // a call to a `void` function) pushes nothing droppable — `t` is then not a
  // `{ kind }`-bearing ValType, so this guard skips the drop and avoids a stack
  // underflow.
  if (t !== null && t !== undefined && typeof t === "object" && "kind" in t) {
    fctx.body.push({ op: "drop" });
  }
}

function resolveStaticPropKey(ctx: CodegenContext, element: ts.BindingElement): string | undefined {
  const pn = element.propertyName ?? element.name;
  if (ts.isIdentifier(pn)) return pn.text;
  if (ts.isStringLiteral(pn) || ts.isNumericLiteral(pn)) return pn.text;
  if (ts.isComputedPropertyName(pn)) {
    const keyExpr = pn.expression;
    // A string/numeric literal key folds directly.
    if (ts.isStringLiteral(keyExpr) || ts.isNumericLiteral(keyExpr)) return keyExpr.text;
    // Otherwise ask the checker for a literal type (covers `const k = "dyn"`).
    try {
      const t = ctx.checker.getTypeAtLocation(keyExpr);
      if (t.isStringLiteral()) return t.value;
      if (t.isNumberLiteral()) return String(t.value);
    } catch {
      // fall through to undefined — caller fails loudly
    }
  }
  return undefined;
}

/**
 * Detect array binding patterns that, per ECMA-262 §13.3.3.6, perform no
 * iterator observation at all. Per spec:
 *
 *   ArrayBindingPattern : [ ]
 *     1. Return NormalCompletion(empty).        ← NO IteratorStep
 *
 *   ArrayBindingPattern : [ Elision ]            ← each `,` calls IteratorStep
 *   ArrayBindingPattern : [ BindingElementList ] ← each element calls IteratorStep
 *
 * So the ONLY pattern that skips iterator observation entirely is the
 * truly-empty pattern `[]`. Elisions (`[,]`, `[, ,]`) and nested empties
 * (`[[]]`, `[[], []]`) each still consume one IteratorStep per top-level
 * element — they must NOT short-circuit, otherwise:
 *
 *   - `function f([,] = throwingIter) {}; f()` fails to propagate the
 *     iterator's `.next()` throw (#1432 — `dflt-ary-ptrn-elision-step-err`).
 *   - `function f([[]] = iter) {}; f()` fails to advance the iterator,
 *     observably wrong for any iterator with side-effects.
 *
 * #1158 had broadened this short-circuit to cover patterns whose elements
 * were all themselves "empty-only" (`[, ,]`, `[[]]`, `[[], []]`). That was
 * a spec violation: those patterns DO observe the iterator. The narrower
 * definition below restores spec compliance — the truly-empty `[]` is the
 * only pattern that bypasses iteration. (#1432)
 */
function isPatternEmptyOnly(pattern: ts.ArrayBindingPattern): boolean {
  return pattern.elements.length === 0;
}

/**
 * Number of iterator steps an array binding/assignment pattern consumes
 * (§8.5.3 IteratorBindingInitialization). Each element — INCLUDING elision
 * holes (`OmittedExpression`) — costs exactly one IteratorStep. A rest element
 * drains the remainder of the iterator → unbounded → -1.
 *
 * Binding patterns mark rest via `BindingElement.dotDotDotToken`; assignment
 * patterns use `SpreadElement`. The returned count feeds `__array_from_iter_n`
 * so a no-rest pattern materializes EXACTLY `elements.length` steps instead of
 * draining a lazy generator to completion (#1592). `-1` routes through the
 * unbounded (legacy `__array_from_iter`) path, preserving all IteratorClose
 * tuning (#1219).
 */
export function patternIteratorStepCount(elements: readonly (ts.ArrayBindingElement | ts.Expression)[]): number {
  for (const el of elements) {
    if (el && (ts.isSpreadElement(el) || (ts.isBindingElement(el) && !!el.dotDotDotToken))) {
      return -1;
    }
  }
  return elements.length;
}

/**
 * Destructuring mode for the param-destructure helpers (#1553a).
 *
 * - `"param"` (default): function-parameter destructuring; emits no TDZ flags.
 * - `"catch"`: catch-clause destructuring; behaves like `"param"` today
 *   (centralised here so #1552's catch helper can opt in later).
 * - `"decl"`: declaration-form (`let`/`const`/`var`) destructuring; emits
 *   `emitLocalTdzInit` after every binding `local.set`, and (for `let`/`const`)
 *   calls `ensureLetConstBindingPatternTdzFlags` at entry so each bound
 *   identifier has a TDZ flag local before its sibling defaults run.
 */
export type DestructureMode = "param" | "catch" | "decl";

/**
 * Caller-declared binding kind. Only meaningful when `mode === "decl"`:
 *
 * - `"let"` / `"const"`: requires per-binding TDZ flags.
 * - `"var"`: `emitLocalTdzInit` is a no-op (no flag was allocated by the
 *   pre-pass), so behaviour is correct without an extra branch.
 * - `"param"`: catch-mode + param-mode default; the helper ignores it.
 */
export type BindingKind = "let" | "const" | "var" | "param";

export interface DestructureOpts {
  mode?: DestructureMode;
  bindingKind?: BindingKind;
}

/** Internal: should this caller emit TDZ flag init after a binding `local.set`? */
function isDeclMode(opts: DestructureOpts | undefined): boolean {
  return opts?.mode === "decl";
}

/** Internal: should we pre-allocate let/const TDZ flags at helper entry? */
function shouldEnsureLetConstFlags(opts: DestructureOpts | undefined): boolean {
  if (opts?.mode !== "decl") return false;
  const k = opts.bindingKind;
  return k === "let" || k === "const";
}

/**
 * Bounds-checked array.get that returns JS `undefined` (via __get_undefined)
 * for out-of-bounds indices on externref arrays, instead of ref.null.extern.
 * This is critical for destructuring defaults: per ES spec, accessing an array
 * index beyond its length produces `undefined` (which triggers defaults), NOT
 * `null` (which does not).  (#1016a)
 *
 * Stack: [arrayref, i32 index]  →  [externref element or __get_undefined()]
 * Falls through to regular emitBoundsCheckedArrayGet for non-externref types.
 */
function emitBoundsCheckedArrayGetUndef(
  ctx: CodegenContext,
  fctx: FunctionContext,
  arrTypeIdx: number,
  elementType: ValType,
): void {
  if (elementType.kind !== "externref" && elementType.kind !== "ref_extern") {
    emitBoundsCheckedArrayGet(fctx, arrTypeIdx, elementType);
    return;
  }
  // (#2029) `ensureLateImport` does not refuse `__get_undefined`, so in
  // standalone / native-strings mode it would register and LEAK the host import
  // (module then fails to instantiate). Force the standalone fallback here, as
  // the canonical `ensureGetUndefined` does.
  const getUndefIdx = ctx.nativeStrings
    ? undefined
    : ensureLateImport(ctx, "__get_undefined", [], [{ kind: "externref" }]);
  // (#2106 S1) Determine the OOB "undefined" else-arm producer:
  //   - host mode → the `__get_undefined` import call;
  //   - standalone/nativeStrings with the $undefined singleton flag ON → the
  //     tag-1 singleton (so the externref default-check, which is singleton-only
  //     under the flag, fires the destructuring default for a past-length index);
  //   - standalone flag OFF → the legacy fallback below (byte-identical).
  // Without the singleton arm, standalone OOB yielded raw `ref.null.extern`,
  // which the flag-on `__extern_is_undefined` (singleton-only) does NOT treat as
  // undefined → array-pattern defaults spuriously failed to fire (the #2106
  // array-absence producer gap: `[x=9]=[]`, `[,y=9]=[1]`, `[a,b=9]=[1]`).
  const singletonOobInstrs = getUndefIdx === undefined ? undefinedExternInstrs(ctx) : undefined;
  const oobElse: Instr[] | undefined =
    getUndefIdx !== undefined ? [{ op: "call", funcIdx: getUndefIdx }] : singletonOobInstrs;
  if (oobElse === undefined) {
    // standalone flag OFF — can't get JS undefined, fall back to regular path
    emitBoundsCheckedArrayGet(fctx, arrTypeIdx, elementType);
    return;
  }
  flushLateImportShifts(ctx, fctx);

  // Save index and array ref to locals
  const idxLocal = allocLocal(fctx, `__undef_idx_${fctx.locals.length}`, { kind: "i32" });
  const arrLocal = allocLocal(fctx, `__undef_arr_${fctx.locals.length}`, {
    kind: "ref_null",
    typeIdx: arrTypeIdx,
  });
  fctx.body.push({ op: "local.set", index: idxLocal }); // save index
  fctx.body.push({ op: "local.set", index: arrLocal }); // save array ref

  // Condition: (unsigned)idx < array.len
  fctx.body.push({ op: "local.get", index: idxLocal });
  fctx.body.push({ op: "local.get", index: arrLocal });
  fctx.body.push({ op: "array.len" });
  fctx.body.push({ op: "i32.lt_u" });

  // (#2001 S1) An in-bounds `$Hole` slot (a literal elision in an `any[]` being
  // destructured) must bind `undefined`, not the sentinel struct. Map it in the
  // in-bounds `then` arm; the OOB `else` arm already yields `undefined`. Gated on
  // `usesArrayHoles` (externref element is guaranteed here by the guard above).
  const inBoundsThen: Instr[] = [
    { op: "local.get", index: arrLocal },
    { op: "ref.as_non_null" },
    { op: "local.get", index: idxLocal },
    { op: "array.get", typeIdx: arrTypeIdx },
  ];
  if (ctx.usesArrayHoles) inBoundsThen.push(...holeToUndefinedInstrs(ctx, fctx));

  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "externref" } },
    then: inBoundsThen,
    else: oobElse,
  });
}

/**
 * (#2844) Destructure an OBJECT binding pattern from a freshly-built rest vec.
 *
 * Per §13.3.3.6 `BindingRestElement : ... BindingPattern`, an array-pattern rest
 * element collects the remaining iterator values into a fresh `Array A`, then runs
 * BindingInitialization of the inner BindingPattern with `A`. When that inner
 * pattern is an OBJECT pattern (`[...{ 0: v, length: z }]`), the bindings are
 * property reads on the Array object: `length` -> A.length, a non-negative integer
 * key `k` -> A[k] (OOB -> undefined).
 *
 * The generic struct-by-name object destructure does NOT know the rest vec is
 * array-like (the `__vec` struct has no field named `0`), so it silently drops
 * numeric-key bindings. This helper supplies the array-like reads. It is SHARED by
 * the two lanes that build a rest vec and then need an object-from-vec read:
 *   - the function-parameter / decl rest lane (`destructureParamArray`), and
 *   - the for-of / for-await loop-head rest lane (`compileForOfDestructuring`).
 *
 * `vecLocal` holds the (non-null) rest vec ref; `vecTypeIdx`/`arrTypeIdx` describe
 * the vec struct and its backing array. `isDecl` flips per-binding TDZ flags for
 * let/const declarations (a no-op when no flag exists).
 *
 * Scope matches the test262 `*-ary-ptrn-rest-obj-{id,prop-id}` cluster: shorthand
 * / renamed identifier targets keyed by `length` or a non-negative integer.
 * Rest-within-rest, nested sub-patterns, and defaults inside the rest object are
 * out of scope (skipped) — consistent across both lanes.
 */
export function emitObjectPatternRestFromVec(
  ctx: CodegenContext,
  fctx: FunctionContext,
  vecLocal: number,
  vecTypeIdx: number,
  arrTypeIdx: number,
  objPattern: ts.ObjectBindingPattern,
  isDecl: boolean,
): void {
  ensureBindingLocals(ctx, fctx, objPattern);
  for (const nested of objPattern.elements) {
    if (!ts.isBindingElement(nested)) continue;
    if (nested.dotDotDotToken) continue;
    if (!ts.isIdentifier(nested.name)) continue;
    const propNode = nested.propertyName ?? nested.name;
    let key: string | undefined;
    if (ts.isIdentifier(propNode)) key = propNode.text;
    else if (ts.isStringLiteral(propNode)) key = propNode.text;
    else if (ts.isNumericLiteral(propNode)) key = propNode.text;
    if (key === undefined) continue;
    const localName = nested.name.text;
    const localIdx = fctx.localMap.get(localName);
    if (localIdx === undefined) continue;
    const localType = getLocalType(fctx, localIdx);
    if (!localType) continue;
    if (key === "length") {
      fctx.body.push({ op: "local.get", index: vecLocal });
      fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
      coerceType(ctx, fctx, { kind: "i32" }, localType);
      fctx.body.push({ op: "local.set", index: localIdx });
      if (isDecl) emitLocalTdzInit(fctx, localName);
      continue;
    }
    const numKey = Number(key);
    if (Number.isInteger(numKey) && numKey >= 0 && String(numKey) === key) {
      const arrDef = ctx.mod.types[arrTypeIdx];
      const elemWasmType = arrDef && arrDef.kind === "array" ? arrDef.element : ({ kind: "externref" } as ValType);
      fctx.body.push({ op: "local.get", index: vecLocal });
      fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
      fctx.body.push({ op: "i32.const", value: numKey });
      emitBoundsCheckedArrayGetUndef(ctx, fctx, arrTypeIdx, elemWasmType);
      coerceType(ctx, fctx, undefinedPreservingBindingSourceType(nested, elemWasmType), localType);
      fctx.body.push({ op: "local.set", index: localIdx });
      if (isDecl) emitLocalTdzInit(fctx, localName);
    }
  }
}

function boxToExternref(
  ctx: CodegenContext,
  elemKey: string,
  srcElemType?: ValType,
  // (#3315) When provided, the f64 arm emits the UNDEF_F64-sentinel →
  // undefined map (needs a scratch local).
  fctx?: FunctionContext,
): Instr[] {
  // The registry key describes the logical producer, but the backing-array
  // element is the value that is actually on the Wasm stack here.  They can
  // intentionally differ: Int32Array/Uint32Array use the dedicated
  // `i32_elem` key while their storage still yields an i32.  Always prefer the
  // physical element kind for opcode selection; using `elemKey` for that case
  // falls through to `extern.convert_any(i32)` and invalidates the module.
  const storageKind = srcElemType?.kind ?? elemKey;
  // (#2669) When the backing array ALREADY stores externref elements, the value
  // produced by `array.get` is already an externref and needs no conversion.
  // The vec-type-map key alone is misleading here: a `ref_*` keyed vec (a vec of
  // nested arrays/objects, e.g. from `number[][]`) lowers its backing store to
  // `(array (mut externref))` — its elements are boxed to externref — so keying
  // off the `"ref_*"` string would emit `extern.convert_any`, whose operand must
  // be an `anyref`, on an externref `array.get`. That is invalid Wasm and made
  // `const [[x,y,z]=[4,5,6]] = []` (over a `number[][]` source) fail to
  // instantiate. Decide from the real element kind: an externref store is a
  // straight pass-through.
  if (srcElemType && (srcElemType.kind === "externref" || srcElemType.kind === "ref_extern")) {
    return [];
  }
  // (#3024) Packed sub-i32 element carriers (`i8`/`i16` — Int8/Uint8/Uint8Clamped,
  // Int16/Uint16 typed-array backing, and the resizable-ArrayBuffer byte store).
  // Their READ side is a packed `array.get_u` (see the caller) which zero-extends
  // to an i32 in 0..255 / 0..65535 — always non-negative, so `f64.convert_i32_s`
  // == `_u` — then f64-box via `__box_number`. Without this branch a packed carrier
  // fell to the `ref`-type `extern.convert_any` default below, which on an i32
  // operand is invalid Wasm (whole module fails validation). Mirrors the R4
  // dynamic-dispatch chokepoint (`object-runtime.ts` `packedElemReadBox`). The
  // shared carrier type loses the constructor's signedness, so this generic read
  // is unsigned (a negative Int8/Int16 reads its unsigned bit-pattern) — the same
  // documented limitation as the R4 read; recovering it needs a per-signedness
  // carrier type (deferred).
  if (srcElemType && (srcElemType.kind === "i8" || srcElemType.kind === "i16")) {
    addUnionImports(ctx);
    const boxIdx = ctx.funcMap.get("__box_number");
    if (boxIdx !== undefined) {
      return [{ op: "f64.convert_i32_s" }, { op: "call", funcIdx: boxIdx }];
    }
    return [{ op: "drop" }, { op: "ref.null.extern" }];
  }
  if (storageKind === "externref" || storageKind === "ref_extern") {
    // Already externref, just pass through
    return [];
  }
  if (storageKind === "f64") {
    addUnionImports(ctx);
    const boxIdx = ctx.funcMap.get("__box_number");
    if (boxIdx !== undefined) {
      // (#3315) Sentinel-aware box: an f64-vec element can carry the
      // UNDEF_F64_BITS signaling-NaN sentinel for `undefined`
      // (`[7, undefined, ]` — see the #1024 note in literals.ts). A raw
      // `__box_number` turns it into a boxed NUMBER carrying NaN, so the
      // destructured binding loses undefined identity (inline
      // `y === undefined` still passes via the #2979 $BoxedNumber-sentinel
      // observer arm, but the generic any-`===` classifies it a number —
      // `assert_sameValue(y, undefined)` reads false). Map the sentinel to
      // the real `undefined` (standalone singleton / host `__get_undefined`)
      // before boxing. funcMap-lookup only for the host getter (this site is
      // late-shift-fragile — see the #1890 notes below); when neither is
      // available, keep the pre-fix plain box.
      if (fctx) {
        const undefInstrs: Instr[] | undefined =
          undefinedExternInstrs(ctx) ??
          (() => {
            const gu = ctx.funcMap.get("__get_undefined");
            return gu !== undefined ? [{ op: "call", funcIdx: gu } as Instr] : undefined;
          })();
        if (undefInstrs !== undefined) {
          const tmp = allocLocal(fctx, `__f64_sent_${fctx.locals.length}`, { kind: "f64" });
          return [
            { op: "local.tee", index: tmp },
            { op: "i64.reinterpret_f64" },
            { op: "i64.const", value: UNDEF_F64_BITS },
            { op: "i64.eq" },
            {
              op: "if",
              blockType: { kind: "val", type: { kind: "externref" } },
              then: undefInstrs.map((instr) => ({ ...instr })),
              else: [
                { op: "local.get", index: tmp },
                { op: "call", funcIdx: boxIdx },
              ],
            },
          ];
        }
      }
      return [{ op: "call", funcIdx: boxIdx }];
    }
    // Fallback: drop and push null
    return [{ op: "drop" }, { op: "ref.null.extern" }];
  }
  if (storageKind === "i32") {
    addUnionImports(ctx);
    const boxIdx = ctx.funcMap.get("__box_number");
    if (boxIdx !== undefined) {
      return [{ op: "f64.convert_i32_s" }, { op: "call", funcIdx: boxIdx }];
    }
    return [{ op: "drop" }, { op: "ref.null.extern" }];
  }
  if (storageKind === "i64") {
    // (#3394) An i64-carrier vec element (a `bigint`, or a heterogeneous
    // `number | bigint` tuple element stored as i64) must be BOXED before it
    // reifies as an externref — the `array.get` yields a raw i64, and falling
    // to the `ref`-type `extern.convert_any` default below emits it on an i64
    // operand ("extern.convert_any expected anyref, found array.get of type
    // i64"), invalid Wasm. This is the destructuring twin of the coerceType
    // :2001 i64→externref arm and the map-runtime coerceArgToAnyref i64 arm.
    // A BRANDED bigint boxes as a JS bigint via __box_bigint; a native
    // (unbranded) i64 boxes as a number. `bigint`-ness rides `srcElemType`.
    addUnionImports(ctx);
    if (srcElemType?.kind === "i64" && srcElemType.bigint === true) {
      const boxBigIdx = ctx.funcMap.get("__box_bigint");
      if (boxBigIdx !== undefined) {
        return [{ op: "call", funcIdx: boxBigIdx }];
      }
    }
    const boxIdx = ctx.funcMap.get("__box_number");
    if (boxIdx !== undefined) {
      return [{ op: "f64.convert_i64_s" }, { op: "call", funcIdx: boxIdx }];
    }
    return [{ op: "drop" }, { op: "ref.null.extern" }];
  }
  // For ref types: extern.convert_any
  return [{ op: "extern.convert_any" }];
}

export function buildDestructureNullThrow(ctx: CodegenContext, fctx?: FunctionContext): Instr[] {
  const msg = "Cannot destructure 'null' or 'undefined'";
  addStringConstantGlobal(ctx, msg);
  // #1623 — in nativeStrings mode (wasi / standalone) `stringGlobalMap` holds a
  // `-1` sentinel rather than a real import-global index, so a bare
  // `global.get strIdx` lowers to `global.get 0xFFFFFFFF` ("Invalid global
  // index"). `stringConstantExternrefInstrs` materializes the NativeString
  // struct inline (and externref-converts) in that mode, and emits the plain
  // `global.get` only when a real import global exists.
  const pushMsg = () => stringConstantExternrefInstrs(ctx, msg);
  // #1473 — no JS host (wasi / standalone): build a TypeError INSTANCE via the
  // in-module `__new_TypeError` constructor so `e instanceof TypeError`
  // works under wasmtime, with no `__throw_type_error` host import. The
  // constructor is registered in funcMap as an internal function, so
  // ensureLateImport resolves it without adding an import (no index shift).
  if (usesNativeJsErrors(ctx)) {
    emitWasiErrorConstructor(ctx, "TypeError", 1);
    // #1623 — resolve `__new_TypeError` through ensureLateImport (NOT a raw
    // `funcMap.get`). The constructor is an in-module function whose index is
    // computed eagerly; later import additions shift every function index, and
    // only the ensureLateImport / flushLateImportShifts bookkeeping keeps an
    // already-emitted `call` index in sync. A raw `funcMap.get` snapshot goes
    // stale and lowered to `call <wrong-fn>` (e.g. the enclosing function,
    // observed as "throw expected externref, found call of type f64"). This
    // mirrors the proven path in `emitThrowTypeError` (expressions/helpers.ts).
    const newTypeErrorIdx = ensureLateImport(ctx, "__new_TypeError", [{ kind: "externref" }], [{ kind: "externref" }]);
    const tagIdx = ensureExnTag(ctx);
    if (newTypeErrorIdx !== undefined && fctx) {
      flushLateImportShifts(ctx, fctx);
      const funcIdx = ctx.funcMap.get("__new_TypeError")!;
      return [...pushMsg(), { op: "call", funcIdx }, { op: "throw", tagIdx }];
    }
    // Degrade to throwing the raw string with the same tag.
    return [...pushMsg(), { op: "throw", tagIdx }];
  }
  // JS-host: prefer the host import so the caller sees a genuine JS TypeError
  // (constructor-matching tests such as `({constructor}) => constructor ===
  // TypeError` pass). Fall back to wasm throw+tag when a FunctionContext isn't
  // available for late-import flush.
  const throwIdx = ensureLateImport(ctx, "__throw_type_error", [{ kind: "externref" }], []);
  if (throwIdx !== undefined && fctx) {
    flushLateImportShifts(ctx, fctx);
    const funcIdx = ctx.funcMap.get("__throw_type_error")!;
    return [...pushMsg(), { op: "call", funcIdx }, { op: "unreachable" }];
  }
  const tagIdx = ensureExnTag(ctx);
  return [...pushMsg(), { op: "throw", tagIdx }];
}

/**
 * Returns true when `expr` is a literal `null` or `undefined` — which per spec
 * must throw TypeError when used as the source value for a destructuring pattern
 * (RequireObjectCoercible / GetIterator).
 *
 * Used by parameter default-emission to statically reject `({pat} = null)` and
 * `({pat} = undefined)` even when paramType is numeric (loses null/undef info).
 */
export function isNullOrUndefinedLiteral(expr: ts.Expression): boolean {
  if (expr.kind === ts.SyntaxKind.NullKeyword) return true;
  if (ts.isIdentifier(expr) && expr.text === "undefined") return true;
  if (expr.kind === ts.SyntaxKind.VoidExpression) {
    const v = expr as ts.VoidExpression;
    return ts.isNumericLiteral(v.expression);
  }
  return false;
}

/**
 * Destructure a function parameter (externref) using __extern_get for property access.
 * This handles primitives, objects, and any externref value safely — no struct cast needed.
 * Used as fallback when the value is not the expected struct type (#852).
 */
export function destructureParamObjectExternref(
  ctx: CodegenContext,
  fctx: FunctionContext,
  paramIdx: number,
  pattern: ts.ObjectBindingPattern,
  opts: DestructureOpts = {},
): void {
  const isDecl = isDeclMode(opts);
  if (shouldEnsureLetConstFlags(opts)) {
    ensureLetConstBindingPatternTdzFlags(ctx, fctx, pattern);
  }
  // (#1151) RequireObjectCoercible — destructuring a binding pattern against
  // null/undefined must throw a synchronous TypeError (ECMA-262 §8.6.2 step 1,
  // BindingPattern : ObjectBindingPattern). The array param helper and
  // `destructureParamObject`'s own externref arm already emit this guard, but
  // the `compileFunctionExpression` arrow / function-expression path
  // (closures.ts) calls THIS helper directly for an `any`/externref object
  // pattern with no struct to ref.test against, so without the guard
  // `(({a}) => a)(null)` silently returned undefined. The guard only fires for
  // null/undefined; valid objects (and `destructureParamObject` callers that
  // already guarded) pass through unchanged (a second guard on a non-null value
  // is a no-op).
  emitExternrefDestructureGuard(ctx, fctx, paramIdx);
  // Ensure __extern_get is available (#1866: ensureLateImport routes to the
  // native object-runtime impl under --target standalone — no leaked
  // `env::__extern_get` host import — and to the host import in JS-host mode).
  ensureLateImport(ctx, "__extern_get", [{ kind: "externref" }, { kind: "externref" }], [{ kind: "externref" }]);
  flushLateImportShifts(ctx, fctx);
  let getIdx = ctx.funcMap.get("__extern_get");
  if (getIdx === undefined) return;

  const excludedKeys: string[] = [];
  for (const element of pattern.elements) {
    if (!ts.isBindingElement(element) || element.dotDotDotToken) continue;
    const pn = element.propertyName ?? element.name;
    if (ts.isIdentifier(pn)) excludedKeys.push(pn.text);
    else if (ts.isStringLiteral(pn)) excludedKeys.push(pn.text);
    else if (ts.isNumericLiteral(pn)) excludedKeys.push(pn.text);
  }

  for (const element of pattern.elements) {
    if (!ts.isBindingElement(element)) continue;

    if (element.dotDotDotToken) {
      if (!ts.isIdentifier(element.name)) continue;
      const restName = element.name.text;
      let restIdx = fctx.localMap.get(restName);
      if (restIdx === undefined) {
        restIdx = allocLocal(fctx, restName, { kind: "externref" });
      }
      // (#3223/#4397) Native semantic providers use the Wasm-defined
      // __extern_rest_object instead of the legacy host semantic import.
      // The native helper takes an EXCLUSION OBJECT (own keys = excluded
      // property names) rather than the comma-joined string; membership is the
      // proven open-object hash lookup, so there is no runtime string parsing
      // and no delimiter false-match. The host/gc branch below is byte-identical
      // to the prior behaviour.
      if (ctx.targetProfile.semanticProviders === "native-first") {
        // The param is an externref (already an open `$Object` at runtime), so
        // no `materializeStructAsObject` reification is needed here.
        const ok = emitNativeObjectRest(
          ctx,
          fctx,
          () => fctx.body.push({ op: "local.get", index: paramIdx }),
          excludedKeys,
          restIdx,
        );
        getIdx = ctx.funcMap.get("__extern_get");
        if (!ok) continue;
        if (isDecl) emitLocalTdzInit(fctx, restName);
        continue;
      }
      let restObjIdx = ctx.funcMap.get("__extern_rest_object");
      if (restObjIdx === undefined) {
        const importsBefore = ctx.numImportFuncs;
        const restObjType = addFuncType(ctx, [{ kind: "externref" }, { kind: "externref" }], [{ kind: "externref" }]);
        addImport(ctx, "env", "__extern_rest_object", { kind: "func", typeIdx: restObjType });
        shiftLateImportIndices(ctx, fctx, importsBefore, ctx.numImportFuncs - importsBefore);
        restObjIdx = ctx.funcMap.get("__extern_rest_object");
        getIdx = ctx.funcMap.get("__extern_get");
      }
      if (restObjIdx === undefined) continue;
      const excludedStr = excludedKeys.join(",");
      addStringConstantGlobal(ctx, excludedStr);
      const excludedStrIdx = ctx.stringGlobalMap.get(excludedStr);
      if (excludedStrIdx === undefined) continue;
      fctx.body.push({ op: "local.get", index: paramIdx });
      // #1623 — nativeStrings has a -1 sentinel global index; materialize the
      // key string inline as externref instead of `global.get -1`.
      for (const instr of stringConstantExternrefInstrs(ctx, excludedStr)) fctx.body.push(instr);
      fctx.body.push({ op: "call", funcIdx: restObjIdx });
      fctx.body.push({ op: "local.set", index: restIdx });
      if (isDecl) emitLocalTdzInit(fctx, restName);
      continue;
    }

    const propNameNode = element.propertyName ?? element.name;
    let propNameText: string | undefined;
    if (ts.isIdentifier(propNameNode)) {
      propNameText = propNameNode.text;
    } else if (ts.isStringLiteral(propNameNode)) {
      propNameText = propNameNode.text;
    } else if (ts.isNumericLiteral(propNameNode)) {
      propNameText = propNameNode.text;
    } else if (ts.isComputedPropertyName(propNameNode)) {
      // (#2569) A non-constant computed key (`{ [thrower()]: x }`) has no static
      // text to map to a property read, but §13.15.5.3 requires the key
      // expression to be EVALUATED during destructuring (side effect + throw
      // propagation). Run it for its effect and drop the result before skipping
      // the field bind. A constant computed key would have folded above (via
      // resolveStaticPropKey upstream); this externref path only sees the
      // unresolved runtime case.
      emitComputedKeyForEffect(ctx, fctx, propNameNode.expression);
      continue;
    }
    if (!propNameText) continue;

    addStringConstantGlobal(ctx, propNameText);
    const strGlobalIdx = ctx.stringGlobalMap.get(propNameText);
    if (strGlobalIdx === undefined) continue;

    getIdx = ctx.funcMap.get("__extern_get");
    if (getIdx === undefined) continue;

    // (#3178) `done`/`value` destructured off a native generator IteratorResult:
    // raw `__extern_get` only understands $Object receivers, so
    // `.then(({ done, value }) => …)` on an async-gen `next()` result read
    // undefined/undefined (the 280-test yield*-error template family, #3417 F2
    // harvest). Route these two keys through the finalize-filled
    // `__get_member_<name>` dispatcher (#2674) instead — it enumerates every
    // struct candidate owning the field at FINALIZE (so gen-result structs
    // registered after this destructure site still get an arm), boxes the
    // boolean-branded `done` via `__box_boolean` (#3050) and the sentinel f64
    // `value` undefined-aware (#2979), and falls back to `__extern_get` for
    // every non-struct receiver — identical semantics there. Other keys keep
    // the raw `__extern_get` read (minimal dispatch surface; widen only with
    // corpus evidence). Not under wasi (matches the property-access gate).
    let readViaDispatcher = false;
    if (!ctx.wasi && (propNameText === "done" || propNameText === "value")) {
      const dispIdx = reserveMemberGetDispatchLate(ctx, propNameText, fctx);
      if (dispIdx !== undefined) {
        // Re-read post-reserve: the reserve may add late imports and shift indices.
        const refreshedGetIdx = ctx.funcMap.get("__extern_get");
        if (refreshedGetIdx !== undefined) getIdx = refreshedGetIdx;
        fctx.body.push({ op: "local.get", index: paramIdx });
        fctx.body.push({ op: "call", funcIdx: dispIdx });
        readViaDispatcher = true;
      }
    }
    if (!readViaDispatcher) {
      fctx.body.push({ op: "local.get", index: paramIdx });
      // #1623 — nativeStrings has a -1 sentinel global index; materialize the
      // key string inline as externref instead of `global.get -1`.
      for (const instr of stringConstantExternrefInstrs(ctx, propNameText)) fctx.body.push(instr);
      fctx.body.push({ op: "call", funcIdx: getIdx });
    }

    const elemType: ValType = { kind: "externref" };

    if (ts.isIdentifier(element.name)) {
      const localName = element.name.text;
      let localIdx = fctx.localMap.get(localName);
      if (localIdx === undefined) {
        localIdx = allocLocal(fctx, localName, elemType);
      }
      // (#4618) A boxed capture's slot IS the ref cell (a spilled async-frame
      // binding referenced by a hoisted fn-decl). A plain local.set here would
      // coerce the extracted VALUE to the cell type — any.convert_extern +
      // ref.cast on a symbol/object value is a guaranteed trap. Redirect the
      // element's stores to a scratch local typed as the cell's VALUE type,
      // then write the result through the cell (the #3396/#1177
      // boxedForInitStore convention) so captures observe the binding.
      const boxedDstrCell = fctx.boxedCaptures?.get(localName);
      const boxedDstrCellLocalIdx = boxedDstrCell !== undefined ? fctx.localMap.get(localName) : undefined;
      const boxedDstrRedirected =
        boxedDstrCell !== undefined && boxedDstrCellLocalIdx !== undefined && localIdx === boxedDstrCellLocalIdx;
      if (boxedDstrRedirected) {
        localIdx = allocLocal(fctx, `__box_dstr_${localName}_${fctx.locals.length}`, boxedDstrCell.valType);
      }
      const localType = getLocalType(fctx, localIdx);

      if (element.initializer) {
        const tmpElem = allocLocal(fctx, `__ext_dparam_dflt_${fctx.locals.length}`, elemType);
        fctx.body.push({ op: "local.tee", index: tmpElem });

        const undefIdx = ensureLateImport(ctx, "__extern_is_undefined", [{ kind: "externref" }], [{ kind: "i32" }]);
        if (undefIdx !== undefined) {
          flushLateImportShifts(ctx, fctx);
          getIdx = ctx.funcMap.get("__extern_get");
        }

        // Per JS spec, destructuring defaults apply ONLY when the value is `undefined`,
        // not when it is `null`. JS null maps to ref.null.extern (ref.is_null=1) and JS
        // undefined maps to a non-null externref wrapping undefined. We must use
        // __extern_is_undefined exclusively; using ref.is_null would wrongly trigger
        // defaults for null values (#1021).
        if (undefIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx: undefIdx });
        } else {
          // Fallback: if the import couldn't be registered, use ref.is_null (imprecise —
          // treats null as undefined). Previously this was the default behavior.
          fctx.body.push({ op: "ref.is_null" });
        }

        const savedBody = fctx.body;
        const thenInstrs: Instr[] = [];
        // (#2567) Track the detached default-value buffer in `ctx.liveBodies`
        // for the compile window. The initializer can be ANY expression —
        // crucially a function CALL (`b = thrower()`) — whose compilation
        // registers a late import and triggers a func/global-index shift. That
        // shift walks `fctx.body` + `fctx.savedBodies` + `ctx.liveBodies`; while
        // we emit into `thenInstrs` it is detached from `fctx.body` and not on
        // `savedBodies`, so an already-emitted `call <thrower>` would keep its
        // stale-high funcIdx and get mis-remapped at finalize (observed: the
        // call landed on `__typeof_bigint`/`__box_number` scaffolding →
        // `not enough arguments on the stack for call` in `C_method`). Also keep
        // the OUTER body live for the same recursion window — mirrors the
        // struct-fast-path then/else tracking at the `#2158` site below.
        const outerAlreadyLive = ctx.liveBodies.has(savedBody);
        if (!outerAlreadyLive) ctx.liveBodies.add(savedBody);
        ctx.liveBodies.add(thenInstrs);
        fctx.body = thenInstrs;
        compileExpression(ctx, fctx, element.initializer, localType ?? elemType);
        fctx.body.push({ op: "local.set", index: localIdx! });
        fctx.body = savedBody;

        const elseCoerce: Instr[] = [];
        if (localType && !valTypesMatch(elemType, localType)) {
          const savedBody2 = fctx.body;
          fctx.body = elseCoerce;
          ctx.liveBodies.add(elseCoerce);
          coerceType(ctx, fctx, elemType, localType);
          fctx.body = savedBody2;
        }

        fctx.body.push({
          op: "if",
          blockType: { kind: "empty" },
          then: thenInstrs,
          else: [{ op: "local.get", index: tmpElem }, ...elseCoerce, { op: "local.set", index: localIdx! }],
        });
        // The buffers are now reachable via `fctx.body` (spliced into the `if`),
        // so drop the temporary `liveBodies` registrations to avoid the
        // double-shift hazard (#1109) where a body reachable from both `fctx.body`
        // and `liveBodies` is walked twice.
        ctx.liveBodies.delete(thenInstrs);
        ctx.liveBodies.delete(elseCoerce);
        if (!outerAlreadyLive) ctx.liveBodies.delete(savedBody);
        if (isDecl) emitLocalTdzInit(fctx, localName);
      } else {
        if (localType && !valTypesMatch(elemType, localType)) {
          coerceType(ctx, fctx, elemType, localType);
        }
        fctx.body.push({ op: "local.set", index: localIdx });
        if (isDecl) emitLocalTdzInit(fctx, localName);
      }
      // (#4618) Flush the redirected scratch value through the ref cell.
      if (boxedDstrRedirected) {
        fctx.body.push({ op: "local.get", index: boxedDstrCellLocalIdx! });
        fctx.body.push({ op: "ref.is_null" });
        fctx.body.push({
          op: "if",
          blockType: { kind: "empty" },
          then: [],
          else: [
            { op: "local.get", index: boxedDstrCellLocalIdx! },
            { op: "local.get", index: localIdx },
            { op: "struct.set", typeIdx: boxedDstrCell!.refCellTypeIdx, fieldIdx: 0 },
          ],
        });
      }
    } else if (ts.isObjectBindingPattern(element.name) || ts.isArrayBindingPattern(element.name)) {
      const nestedLocal = allocLocal(fctx, `__ext_dparam_nested_${fctx.locals.length}`, elemType);
      fctx.body.push({ op: "local.set", index: nestedLocal });
      ensureBindingLocals(ctx, fctx, element.name);

      // Apply initializer (only when value is `undefined`, per spec — null does
      // NOT trigger default). E.g. `{ w: { x, y, z } = defaults }` (#1225).
      if (element.initializer) {
        const undefIdx = ensureLateImport(ctx, "__extern_is_undefined", [{ kind: "externref" }], [{ kind: "i32" }]);
        if (undefIdx !== undefined) {
          flushLateImportShifts(ctx, fctx);
          fctx.body.push({ op: "local.get", index: nestedLocal });
          fctx.body.push({ op: "call", funcIdx: undefIdx });
          const savedBodyInit = fctx.body;
          const initThen: Instr[] = [];
          fctx.body = initThen;
          // Compile initializer; coerce to externref so we can store back.
          // (#2568) In a no-JS-host target the nested binding's value is read
          // back through `__extern_get` (this is the externref destructuring
          // path). A plain object-literal default compiled with the externref
          // hint materializes as a CLOSED STRUCT (`extern.convert_any` of a
          // WasmGC struct), which `__extern_get` cannot index → the inner
          // bindings read 0. Build the default as a `$Object` instead (same fix
          // as literals.ts:272 for nested struct-consumed literals) so the
          // subsequent `__extern_get` reads its fields. Only for resolvable
          // key/value object literals; everything else keeps the normal path.
          const initIsPlainObjectLiteral =
            (ctx.standalone || ctx.wasi) &&
            ts.isObjectLiteralExpression(element.initializer) &&
            element.initializer.properties.length > 0 &&
            element.initializer.properties.every(
              (p) => ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p),
            );
          const initType = initIsPlainObjectLiteral
            ? compileObjectLiteralAsExternref(ctx, fctx, element.initializer as ts.ObjectLiteralExpression)
            : compileExpression(ctx, fctx, element.initializer, elemType);
          if (initType && initType.kind !== "externref") {
            if (initType.kind === "ref" || initType.kind === "ref_null") {
              fctx.body.push({ op: "extern.convert_any" });
            } else if (initType.kind === "f64") {
              const bIdx = ctx.funcMap.get("__box_number");
              if (bIdx !== undefined) fctx.body.push({ op: "call", funcIdx: bIdx });
            } else if (initType.kind === "i32") {
              fctx.body.push({ op: "f64.convert_i32_s" });
              const bIdx = ctx.funcMap.get("__box_number");
              if (bIdx !== undefined) fctx.body.push({ op: "call", funcIdx: bIdx });
            }
          }
          fctx.body.push({ op: "local.set", index: nestedLocal });
          fctx.body = savedBodyInit;
          fctx.body.push({
            op: "if",
            blockType: { kind: "empty" },
            then: initThen,
            else: [],
          });
        }
      }

      // Per ECMA-262 8.6.2 BindingInitialization, both
      // `BindingPattern : ObjectBindingPattern` (RequireObjectCoercible) and
      // `BindingPattern : ArrayBindingPattern` (GetIterator) run their
      // coercibility step FIRST — even for an empty nested pattern `{}` / `[]`.
      // So `{ w: {} } = { w: null }` and `{ w: [] } = { w: null }` must throw
      // TypeError. Emit the null/undefined guard unconditionally (the prior
      // `length > 0` gate skipped empty nested patterns — #846). The guard only
      // fires for null/undefined, so coercible primitive values still pass.
      // (#1225 / #846)
      emitExternrefDestructureGuard(ctx, fctx, nestedLocal);

      if (ts.isObjectBindingPattern(element.name)) {
        destructureParamObjectExternref(ctx, fctx, nestedLocal, element.name, opts);
      } else {
        destructureParamArray(ctx, fctx, nestedLocal, element.name, elemType, opts);
      }
    }
  }
}

/**
 * Emit a null/undefined check for an externref destructuring parameter.
 * Checks both ref.is_null (Wasm null) and __extern_is_undefined (JS undefined).
 * Throws TypeError if either is true.
 */
export function emitExternrefDestructureGuard(ctx: CodegenContext, fctx: FunctionContext, paramIdx: number): void {
  // Check ref.is_null first (handles null)
  fctx.body.push({ op: "local.get", index: paramIdx });
  fctx.body.push({ op: "ref.is_null" });
  fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: buildDestructureNullThrow(ctx, fctx), else: [] });

  // Also check JS undefined via __extern_is_undefined import.
  //
  // (#3010) HOST-MODE ONLY for the *container* guard. In host mode this catches a
  // genuine JS `undefined` container (`let {x} = undefined` → TypeError) which is
  // a real externref distinct from `null`. In standalone/wasi it must NOT run:
  //   - The canonical standalone undefined is the null externref, already caught
  //     by the `ref.is_null` check above — so this second call was historically
  //     redundant (pre-#2979 `__extern_is_undefined` *was* bare `ref.is_null`).
  //   - After #2979 `__extern_is_undefined` became sentinel-aware: it also reports
  //     `true` for a `$BoxedNumber` carrying the UNDEF_F64 sentinel. That is
  //     correct for *value* sites (`g.next().value === undefined`, element-default
  //     application) but WRONG for a destructure *container*: a single-element
  //     array-literal argument `f([undefined])` is scalarized at the call site to
  //     exactly that boxed-sentinel, so the sentinel-aware container guard misread
  //     the array as "undefined" and threw "Cannot destructure 'null' or
  //     'undefined'" at runtime — regressing 55 `class/dstr/*meth-ary-ptrn-elem-
  //     id-init-*` test262 files. Element-level default checks (which DO want the
  //     sentinel awareness) call `__extern_is_undefined` directly elsewhere and
  //     are unaffected. So: keep the sentinel-aware call for value sites, but for
  //     the container guard rely on `ref.is_null` alone under standalone/wasi.
  //
  // (#3010 follow-up) CRITICAL: the `ensureLateImport` + `flushLateImportShifts`
  // side effects MUST run UNCONDITIONALLY in both host and standalone/wasi modes.
  // The first #2570 attempt gated the ENTIRE block (registration + flush + the
  // three emitted instructions) behind `!standalone && !wasi`. Skipping the
  // registration/flush in standalone perturbed the late-import/funcIdx
  // bookkeeping for the rest of the function body: a later `call funcIdx` in the
  // enclosing method got miswired, so `method([])` (an empty array pattern, which
  // per §13.3.3.6 must perform NO iterator observation) instead invoked the
  // argument generator's `.next()` — regressing all 24 `class/dstr/*ary-ptrn-
  // empty` files (statement + expression meth/gen/private/static/async variants),
  // which PASS on plain main. `__extern_is_undefined` is already registered
  // unconditionally at the value-default sites below (and pre-#2570 this guard
  // registered it in every mode), so the registration itself is host-free-safe —
  // it resolves to the native impl under standalone with no leaked host import.
  // Therefore: keep registration + flush identical to main in ALL modes, and gate
  // ONLY the three emitted throw-check instructions to host mode. This makes the
  // change byte-identical to main for host mode and, for standalone, a pure
  // removal of the three erroneous instructions with the funcIdx accounting
  // preserved exactly as main computed it.
  const undefIdx = ensureLateImport(ctx, "__extern_is_undefined", [{ kind: "externref" }], [{ kind: "i32" }]);
  if (undefIdx !== undefined) {
    flushLateImportShifts(ctx, fctx);
    if (!ctx.standalone && !ctx.wasi) {
      fctx.body.push({ op: "local.get", index: paramIdx });
      fctx.body.push({ op: "call", funcIdx: undefIdx });
      fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: buildDestructureNullThrow(ctx, fctx), else: [] });
    } else if (undefinedSingletonActive(ctx)) {
      // (#2106 S1) Under the singleton regime a standalone `undefined`
      // container is a NON-null externref, so the `ref.is_null` guard above
      // misses it. Test the tag-1 `$AnyValue` shape ONLY — deliberately NOT
      // the sentinel-aware `__extern_is_undefined`, whose UNDEF_F64
      // `$BoxedNumber` arm false-positives on a scalarized `[undefined]`
      // array container (the #3010 55-test regression).
      const scratchAny = allocLocal(fctx, `__s1_dguard_any_${fctx.locals.length}`, { kind: "anyref" });
      if (emitIsUndefinedSingletonExternAt(ctx, fctx, paramIdx, scratchAny)) {
        fctx.body.push({
          op: "if",
          blockType: { kind: "empty" },
          then: buildDestructureNullThrow(ctx, fctx),
          else: [],
        });
      }
    }
  }
}

/**
 * (#2568) Derive the WasmGC struct type a destructuring object binding pattern
 * resolves to, as a `ref`-typed compile hint for the pattern's default object
 * literal. Mirrors the struct-type derivation in `destructureParamObject` below
 * so an outer param default materializes in the SAME shape the destructuring
 * `ref.test`/`ref.cast` expects (otherwise the default boxes its nested fields
 * to externref → a `{ field: externref }` struct that fails the `ref.test`, drops
 * to the `__extern_get` else-branch, and reads 0). Returns `undefined` when no
 * resolvable struct exists (rest pattern, missing fields, primitive) — the
 * caller then keeps the externref hint. Shared by the class-method
 * (class-bodies.ts) and plain-function (function-body.ts) param-default sites.
 */
export function structHintForBindingPattern(
  ctx: CodegenContext,
  pattern: ts.ObjectBindingPattern,
): ValType | undefined {
  if (pattern.elements.some((e) => ts.isBindingElement(e) && !!e.dotDotDotToken)) return undefined;
  const tsType = ctx.checker.getTypeAtLocation(pattern);
  if (!tsType) return undefined;
  ensureStructForType(ctx, tsType);
  const typeName = ctx.anonTypeMap.get(tsType) ?? tsType.getSymbol()?.name ?? tsType.aliasSymbol?.name;
  const structTypeIdx = typeName ? ctx.structMap.get(typeName) : undefined;
  if (structTypeIdx === undefined) return undefined;
  // Only hint the struct when every named pattern property is declared on it —
  // otherwise the destructuring itself abandons the struct fast path and a
  // struct hint would just mismatch.
  const structName = ctx.typeIdxToStructName.get(structTypeIdx);
  const fields = structName ? ctx.structFields.get(structName) : undefined;
  if (!fields) return undefined;
  for (const element of pattern.elements) {
    if (!ts.isBindingElement(element) || element.dotDotDotToken) continue;
    const pn = element.propertyName ?? element.name;
    let propText: string | undefined;
    if (ts.isIdentifier(pn)) propText = pn.text;
    else if (ts.isStringLiteral(pn)) propText = pn.text;
    else if (ts.isNumericLiteral(pn)) propText = pn.text;
    if (propText === undefined) continue;
    if (!fields.some((f) => f.name === propText)) return undefined;
  }
  return { kind: "ref", typeIdx: structTypeIdx };
}

/**
 * Destructure a function parameter that is an ObjectBindingPattern.
 * The parameter value (a struct ref) is at param index `paramIdx`.
 * We extract each bound field into a new local.
 */
export function destructureParamObject(
  ctx: CodegenContext,
  fctx: FunctionContext,
  paramIdx: number,
  pattern: ts.ObjectBindingPattern,
  paramType: ValType,
  opts: DestructureOpts = {},
): void {
  const isDecl = isDeclMode(opts);
  if (shouldEnsureLetConstFlags(opts)) {
    ensureLetConstBindingPatternTdzFlags(ctx, fctx, pattern);
  }
  if (paramType.kind !== "ref" && paramType.kind !== "ref_null") {
    // externref parameters: convert to struct ref before destructuring (#647)
    if (paramType.kind === "externref") {
      // Per JS spec: destructuring null/undefined must throw TypeError
      emitExternrefDestructureGuard(ctx, fctx, paramIdx);

      // Pre-allocate all binding locals so they exist regardless of path taken
      ensureBindingLocals(ctx, fctx, pattern);

      // If empty pattern ({}) — nothing to destructure after null guard (#852)
      if (pattern.elements.length === 0) return;

      const tsType = ctx.checker.getTypeAtLocation(pattern);
      let structTypeIdx: number | undefined;
      if (tsType) {
        ensureStructForType(ctx, tsType);
        const typeName = ctx.anonTypeMap.get(tsType) ?? tsType.getSymbol()?.name ?? tsType.aliasSymbol?.name;
        structTypeIdx = typeName ? ctx.structMap.get(typeName) : undefined;
      }
      // Patterns with a rest element (`{...x}`) cannot use the struct-ref fast
      // path — struct.get only exposes known fields, but spec-compliant rest
      // must enumerate every own property (including getters, accessors).
      // Always route through __extern_rest_object for rest patterns.
      const hasRestElement = pattern.elements.some((e) => ts.isBindingElement(e) && !!e.dotDotDotToken);
      if (hasRestElement) structTypeIdx = undefined;

      // The struct fast path uses `struct.get` for property reads, which:
      //   (a) silently returns the field's default value when a pattern
      //       property is not declared on the struct, and
      //   (b) bypasses any JS-defined accessors installed via
      //       `Object.defineProperty`, even when the struct has the field.
      //
      // Per ECMA-262 §13.15.5.6 (Runtime Semantics: KeyedBindingInitialization),
      // each binding element runs `Let v be GetV(value, propertyName)` (§7.3.3),
      // which performs an ordinary `[[Get]]` and *must* fire JS getters. If a
      // getter throws (e.g. test262 dstr/*-get-value-err.js), the error must
      // propagate, not be silently dropped.
      //
      // We cannot statically tell whether a runtime object has had accessors
      // installed via Object.defineProperty, but we *can* tell when the
      // pattern names properties the struct does not declare — in that case
      // the fast path is provably wrong (fieldIdx === -1 → silent skip in the
      // recursive call below). Fall back to __extern_get for the entire
      // pattern in that case so that getters fire and exceptions propagate
      // (#1016 — getter-throw destructure cluster).
      if (structTypeIdx !== undefined) {
        const structName = ctx.typeIdxToStructName.get(structTypeIdx);
        const fields = structName ? ctx.structFields.get(structName) : undefined;
        let allFieldsPresent = !!fields;
        if (fields) {
          for (const element of pattern.elements) {
            if (!ts.isBindingElement(element)) continue;
            if (element.dotDotDotToken) continue;
            const pn = element.propertyName ?? element.name;
            let propText: string | undefined;
            if (ts.isIdentifier(pn)) propText = pn.text;
            else if (ts.isStringLiteral(pn)) propText = pn.text;
            else if (ts.isNumericLiteral(pn)) propText = pn.text;
            if (propText === undefined) continue;
            if (!fields.some((f) => f.name === propText)) {
              allFieldsPresent = false;
              break;
            }
          }
        } else {
          allFieldsPresent = false;
        }
        if (!allFieldsPresent) structTypeIdx = undefined;
      }

      if (structTypeIdx !== undefined) {
        // Use ref.test to check if the value is the expected struct (safe for primitives) (#852)
        const anyTmp = allocLocal(fctx, `__dparam_any_${fctx.locals.length}`, { kind: "anyref" } as ValType);
        fctx.body.push({ op: "local.get", index: paramIdx });
        fctx.body.push({ op: "any.convert_extern" });
        fctx.body.push({ op: "local.set", index: anyTmp });

        fctx.body.push({ op: "local.get", index: anyTmp });
        fctx.body.push({ op: "ref.test", typeIdx: structTypeIdx });

        // Then branch: cast succeeds — use struct-based destructuring (fast path)
        const convertedType: ValType = { kind: "ref_null", typeIdx: structTypeIdx };
        const tmpLocal = allocLocal(fctx, `__dparam_cvt_${fctx.locals.length}`, convertedType);
        const thenInstrs: Instr[] = [];
        const elseInstrs: Instr[] = [];
        // (#779d) Register both branch buffers in liveBodies for the whole
        // construction window. Each branch compiles a binding default that may
        // emit a forward `call` to a function declared later (e.g.
        // `method({ x = thrower() })`). When the *second* branch's compilation
        // adds a late/union import, the function indices shift — but the *first*
        // branch's buffer is detached from fctx.body at that moment (swapped back
        // to savedBody), so the shift walk would miss its stale `call` funcIdx,
        // leaving an off-by-one call. liveBodies is walked by every shift path, so
        // keeping them tracked until the `if` is emitted closes the orphan window.
        ctx.liveBodies.add(thenInstrs);
        ctx.liveBodies.add(elseInstrs);
        const savedBody = fctx.body;
        // (#2158) Also track the OUTER body (savedBody) in liveBodies for the
        // recursion window. This struct-fast-path swap detaches `fctx.body` to a
        // branch buffer via a plain JS-local swap (not pushBody), so the outer
        // body is NOT on `fctx.savedBodies`. A late-import shift triggered deep
        // inside the recursive `destructureParamObjectExternref` /
        // `destructureParamArray` calls (e.g. `__array_from_iter_n` /
        // `__extern_get_idx` for a nested array sub-pattern `{ x: [y] } = …`)
        // walks fctx.body + savedBodies + liveBodies, but the orphaned outer
        // body was unreachable from all three — so a `call`/`ref.func` already
        // emitted into it (the param-default `if (call __extern_is_undefined)`
        // missing-arg guard) kept a stale-low funcIdx and the `if` consumed an
        // externref where i32 was expected → invalid Wasm. Tracking the outer
        // body closes that window (mirrors the then/else tracking above).
        const outerAlreadyLive = ctx.liveBodies.has(savedBody);
        if (!outerAlreadyLive) ctx.liveBodies.add(savedBody);
        fctx.body = thenInstrs;
        fctx.body.push({ op: "local.get", index: anyTmp });
        fctx.body.push({ op: "ref.cast", typeIdx: structTypeIdx });
        fctx.body.push({ op: "local.set", index: tmpLocal });
        destructureParamObject(ctx, fctx, tmpLocal, pattern, convertedType, opts);
        fctx.body = savedBody;

        // Else branch: cast would fail (primitive/different struct) — use __extern_get (#852)
        fctx.body = elseInstrs;
        destructureParamObjectExternref(ctx, fctx, paramIdx, pattern, opts);
        fctx.body = savedBody;

        fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: thenInstrs, else: elseInstrs });
        ctx.liveBodies.delete(thenInstrs);
        ctx.liveBodies.delete(elseInstrs);
        if (!outerAlreadyLive) ctx.liveBodies.delete(savedBody);
      } else {
        // No struct type found — use __extern_get for all properties (#852)
        destructureParamObjectExternref(ctx, fctx, paramIdx, pattern, opts);
      }
      return;
    }
    // Cannot destructure a non-ref type — register locals with defaults
    for (const element of pattern.elements) {
      if (ts.isOmittedExpression(element)) continue;
      if (ts.isIdentifier(element.name)) {
        const name = element.name.text;
        if (!fctx.localMap.has(name)) {
          const elemType = ctx.checker.getTypeAtLocation(element);
          // (#3315) Route through resolveBindingElementType (NOT bare
          // resolveWasmType) so parameter array-pattern elements without a
          // default get the undefined-preserving externref rep — keeping the
          // local's type consistent regardless of which allocation site runs
          // first (ensureBindingLocals applies the same rule).
          allocLocal(
            fctx,
            name,
            resolveBindingElementType(element as ts.BindingElement, elemType, (t) => resolveWasmType(ctx, t)),
          );
          if (isUndefWidenedBindingElement(element as ts.BindingElement, resolveWasmType(ctx, elemType))) {
            (fctx.undefWidenedLocals ??= new Set()).add(name);
          }
        }
      }
    }
    return;
  }

  const structTypeIdx = (paramType as { typeIdx: number }).typeIdx;

  // Find struct name and fields
  const structName = ctx.typeIdxToStructName.get(structTypeIdx);
  const fields = structName ? ctx.structFields.get(structName) : undefined;
  if (!fields) {
    // Cannot find struct info — register locals with defaults
    for (const element of pattern.elements) {
      if (ts.isOmittedExpression(element)) continue;
      if (ts.isIdentifier(element.name)) {
        const name = element.name.text;
        if (!fctx.localMap.has(name)) {
          const elemType = ctx.checker.getTypeAtLocation(element);
          // (#3315) Route through resolveBindingElementType (NOT bare
          // resolveWasmType) so parameter array-pattern elements without a
          // default get the undefined-preserving externref rep — keeping the
          // local's type consistent regardless of which allocation site runs
          // first (ensureBindingLocals applies the same rule).
          allocLocal(
            fctx,
            name,
            resolveBindingElementType(element as ts.BindingElement, elemType, (t) => resolveWasmType(ctx, t)),
          );
          if (isUndefWidenedBindingElement(element as ts.BindingElement, resolveWasmType(ctx, elemType))) {
            (fctx.undefWidenedLocals ??= new Set()).add(name);
          }
        }
      }
    }
    return;
  }

  // Pre-allocate all binding locals so they exist even when param is null
  ensureBindingLocals(ctx, fctx, pattern);

  // Null guard: wrap destructuring in if-not-null for ref params.
  // Always treat as nullable — callers may pass mismatched values that
  // compile to ref.null even when the declared type is non-nullable ref (#852).
  const isNullable = paramType.kind === "ref_null" || paramType.kind === "ref";
  // Pre-warm the null-guard message before populating the detached
  // `destructInstrs` buffer (#1529 — same rationale as the vec/tuple paths,
  // #1553d). `buildDestructureNullThrow` calls `addStringConstantGlobal`, which
  // inserts an import global and shifts every existing global.get/global.set
  // index. By the time it fires (in the null-guard close below) `fctx.body` has
  // already been restored to `savedBody`, and `destructInstrs` lives only in
  // the not-yet-pushed `if.else`, so a default like `{ c = ++n }` that reads a
  // module global kept a stale index pointing at the new string-constant import
  // (externref) instead of the intended f64 global. Warming the constant up
  // front makes the close a no-op for global indices.
  if (isNullable && pattern.elements.length > 0) {
    addStringConstantGlobal(ctx, "Cannot destructure 'null' or 'undefined'");
  }
  const savedBody = fctx.body;
  const destructInstrs: Instr[] = [];
  if (isNullable) {
    // Keep `destructInstrs` reachable to global/late-import index fixups while
    // it is the active emission buffer (#1553d) — a function-call default
    // (`{ c = f() }`, where `f` adds a late import) would otherwise corrupt
    // indices in this buffer.
    fctx.savedBodies.push(destructInstrs);
    fctx.body = destructInstrs;
  }

  for (const element of pattern.elements) {
    if (!ts.isBindingElement(element)) continue;
    // #2032 — resolve the property key statically. A ComputedPropertyName
    // (`{ [k]: v }`) has no `.text`; recover the constant string from the
    // checker so it maps to the correct struct field instead of binding the
    // zero-initialized local. Unresolvable computed keys fail loudly below.
    const propKey = resolveStaticPropKey(ctx, element);
    if (propKey === undefined && element.propertyName && ts.isComputedPropertyName(element.propertyName)) {
      // #2569 — a computed key that does NOT fold to a compile-time constant
      // (e.g. `{ [thrower()]: x }`, a runtime call) cannot be mapped to a struct
      // field index on this static fast path, so the binding is skipped (the
      // local was pre-allocated by `ensureBindingLocals`). BUT §13.15.5.3
      // requires the ComputedPropertyName expression to be EVALUATED as part of
      // the destructuring — for its side effect and, critically, so a throwing
      // key propagates (`assert.throws(... { [thrower()]: x } ...)`). The
      // pre-#2032 `continue` dropped the key expression entirely, so the poison
      // never fired and the side effect never ran. Compile the key expression
      // for its effect (ToPropertyKey ordering is observable via the throw), then
      // drop its value, before skipping the field bind.
      emitComputedKeyForEffect(ctx, fctx, element.propertyName.expression);
      continue;
    }
    if (!ts.isIdentifier(element.name)) {
      // Nested pattern — recurse
      if (ts.isObjectBindingPattern(element.name) || ts.isArrayBindingPattern(element.name)) {
        const fieldIdx = fields.findIndex((f) => f.name === propKey);
        if (fieldIdx === -1) {
          reportSilentFallback(ctx, "lookup-miss-skip", "destructuring-params:nested-pattern-field-miss", element);
          continue;
        }
        const fieldType = fields[fieldIdx]!.type;
        const tmpLocal = allocLocal(fctx, `__dparam_${fctx.locals.length}`, fieldType);
        fctx.body.push({ op: "local.get", index: paramIdx });
        fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx });
        fctx.body.push({ op: "local.set", index: tmpLocal });
        // Handle default initializer for nested object destructuring (#794)
        if (element.initializer) {
          (ctx as any)._arrayLiteralForceVec = true;
          try {
            emitNestedBindingDefault(ctx, fctx, tmpLocal, fieldType, element.initializer);
          } finally {
            (ctx as any)._arrayLiteralForceVec = false;
          }
        }
        if (ts.isObjectBindingPattern(element.name)) {
          destructureParamObject(ctx, fctx, tmpLocal, element.name, fieldType, opts);
        } else {
          destructureParamArray(ctx, fctx, tmpLocal, element.name, fieldType, opts);
        }
      }
      continue;
    }
    const localName = element.name.text;
    const fieldIdx = fields.findIndex((f) => f.name === propKey);
    if (fieldIdx === -1) {
      // Field not in struct — already pre-allocated by ensureBindingLocals
      continue;
    }
    const fieldType = fields[fieldIdx]!.type;
    // Only allocate if not already pre-allocated by ensureBindingLocals
    if (!fctx.localMap.has(localName)) {
      allocLocal(fctx, localName, fieldType);
    }
    const localIdx = fctx.localMap.get(localName)!;
    fctx.body.push({ op: "local.get", index: paramIdx });
    fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx });

    // Handle default value: `function f({ x = defaultVal }: ...) {}`
    // When the struct field holds the "undefined" sentinel (NaN for f64,
    // ref.null for refs), evaluate the initializer instead. (#823)
    if (element.initializer) {
      // Object-property semantics (§13.3.3.7): JS `null` here must NOT fire the
      // default — only `undefined` does. (#1550)
      emitDefaultValueCheck(ctx, fctx, fieldType, localIdx, element.initializer, undefined, true);
      if (isDecl) emitLocalTdzInit(fctx, localName);
    } else {
      // Coerce struct field type to local's declared type if they differ (#658)
      const objLocalType = getLocalType(fctx, localIdx);
      if (objLocalType && !valTypesMatch(fieldType, objLocalType)) {
        coerceType(ctx, fctx, fieldType, objLocalType);
      }
      fctx.body.push({ op: "local.set", index: localIdx });
      if (isDecl) emitLocalTdzInit(fctx, localName);
    }
  }

  // Close null guard — throw TypeError when null (JS spec: destructuring null/undefined is TypeError).
  // Skip for empty `{}` patterns (#225): the guard should only fire when there are
  // actual property accesses that would trap.
  if (isNullable && pattern.elements.length > 0) {
    // `buildDestructureNullThrow` may still add a late import (its TypeError
    // construction), so keep `destructInstrs` on `fctx.savedBodies` until after
    // the `if.else` is assembled — then pop it, since it is reachable via the
    // restored `savedBody` and an extra stack entry would be walked twice by a
    // later shift (#1529).
    fctx.body = savedBody;
    fctx.body.push({ op: "local.get", index: paramIdx });
    fctx.body.push({ op: "ref.is_null" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: buildDestructureNullThrow(ctx, fctx),
      else: destructInstrs,
    });
    fctx.savedBodies.pop();
  } else if (isNullable) {
    fctx.body = savedBody;
    fctx.body.push(...destructInstrs);
    fctx.savedBodies.pop();
  }
}

/**
 * Destructure a function parameter that is an ArrayBindingPattern.
 * The parameter value (a vec struct ref) is at param index `paramIdx`.
 * We extract each element into a new local.
 */
export function destructureParamArray(
  ctx: CodegenContext,
  fctx: FunctionContext,
  paramIdx: number,
  pattern: ts.ArrayBindingPattern,
  paramType: ValType,
  opts: DestructureOpts = {},
): void {
  // #1719 S2 gate-site (second of two): this is the shared vec/tuple lowering
  // that `compileArrayDestructuring` delegates to (and the parameter-dstr
  // lane). When the ITER_OVERRIDDEN brand is set and `paramType` is a real
  // array (not a string), S2 routes the typed-vec/tuple path below through the
  // host-Array reflection + host GetIterator (see `arrayDstrNeedsIdentity` in
  // statements/destructuring.ts). S1 does not wire it here — placement note
  // only; the typed path stays byte-identical when the brand is clear.
  const isDecl = isDeclMode(opts);
  if (shouldEnsureLetConstFlags(opts)) {
    ensureLetConstBindingPatternTdzFlags(ctx, fctx, pattern);
  }

  // (#1719 CPR-2) Parameter / externref-decl array destructuring: when the
  // program overrode Array.prototype[@@iterator] and `paramType` is a real array
  // (not a string), drive the captured override from the value local instead of
  // the backing-store / __array_from_iter lane (§8.5.2). The typed-vec *decl*
  // case never reaches here — `compileArrayDestructuring` runs its own drive and
  // returns before delegating — so this covers exactly the parameter-dstr and
  // externref-decl lanes. Strictly gated behind the brand + a captured override
  // (both clear in the common case ⇒ byte-identical). The value lives in
  // `paramIdx`, so feed the shared decl read-drive that local.
  if (arrayDstrNeedsIdentity(ctx, false) && arrayIteratorOverrideGlobalIdx(ctx) !== undefined) {
    ensureBindingLocals(ctx, fctx, pattern);
    if (tryEmitArrayProtoIteratorReadDrive(ctx, fctx, pattern, paramType, paramIdx)) {
      if (isDecl) syncDestructuredLocalsToGlobals(ctx, fctx, pattern);
      return;
    }
  }

  if (paramType.kind !== "ref" && paramType.kind !== "ref_null") {
    // externref parameters: convert to vec struct before destructuring (#647)
    // The externref may wrap any vec type at runtime (e.g. __vec_f64 from [1,2,3]
    // or __vec_externref from untyped arrays). We convert to __vec_externref
    // since that's what the rest of the code expects for untyped patterns.
    if (paramType.kind === "externref") {
      // Per JS spec: destructuring null/undefined must throw TypeError
      emitExternrefDestructureGuard(ctx, fctx, paramIdx);

      // Per spec §13.3.3.6 (IteratorBindingInitialization), an
      // empty `[]` pattern body returns unused without iterating. Materializing
      // the source via __array_from_iter would call .next() on a generator and
      // execute its body — observably wrong (#1016 — empty pattern advances
      // generator). For empty patterns the null guard above is sufficient.
      // (IteratorClose's spec-prescribed `return()` call on a fresh generator
      // does not execute the body, so skipping it is benign for iterCount.)
      //
      // #1158: broaden the short-circuit to any pattern whose elements are all
      // themselves empty-only — `[, ,]`, `[[]]`, `[[], []]`. Each such element
      // also requires no IteratorStep call, so we can skip materialization
      // entirely. Locals declared by nested empty patterns (rare, since they
      // bind nothing, but still possible via `var` hoisting) are pre-allocated
      // by `ensureBindingLocals`.
      if (isPatternEmptyOnly(pattern)) {
        ensureBindingLocals(ctx, fctx, pattern);
        return;
      }

      const extVecIdx = getOrRegisterVecType(ctx, "externref", { kind: "externref" });
      const extArrTypeIdx = getArrTypeIdxFromVec(ctx, extVecIdx);
      const convertedType: ValType = { kind: "ref_null", typeIdx: extVecIdx };
      const resultLocal = allocLocal(fctx, `__dparam_cvt_${fctx.locals.length}`, convertedType);

      // #1970 — reset resultLocal to null at the start of the emitted
      // sequence. The materialization fallbacks below are gated on
      // `ref.is_null resultLocal`; when this sequence re-executes inside a
      // loop (for-of over Map/host iterables lowers through
      // compileExternrefArrayDestructuringDecl per iteration), a stale
      // non-null vec from the previous iteration would skip re-materializing
      // and destructure last iteration's values forever.
      fctx.body.push({ op: "ref.null", typeIdx: extVecIdx });
      fctx.body.push({ op: "local.set", index: resultLocal });

      // Convert externref -> anyref
      const anyTmp = allocLocal(fctx, `__dparam_any_${fctx.locals.length}`, { kind: "anyref" } as ValType);
      fctx.body.push({ op: "local.get", index: paramIdx });
      fctx.body.push({ op: "any.convert_extern" });
      fctx.body.push({ op: "local.set", index: anyTmp });

      // Tuple-struct fast path (#862): if the externref wraps a known Wasm-native
      // tuple struct (fields named _0, _1, …), destructure directly via
      // struct.get instead of routing through __array_from_iter / boxing — which
      // would convert typed numeric fields to externref and then silently back
      // to NaN when assigned to f64 locals (PR #255 regression pattern).
      //
      // The sentinel `__dparam_done` is set to 1 if the fast path fires; the
      // existing externref logic below is gated on it being 0.
      const dstrDoneLocal = allocLocal(fctx, `__dparam_done_${fctx.locals.length}`, { kind: "i32" });
      fctx.body.push({ op: "i32.const", value: 0 });
      fctx.body.push({ op: "local.set", index: dstrDoneLocal });

      for (let ti = 0; ti < ctx.mod.types.length; ti++) {
        const def = ctx.mod.types[ti];
        if (!def || def.kind !== "struct") continue;
        if (def.fields.length === 0) continue;
        // Tuple struct detection: fields must be named _0, _1, _2, ...
        let isTuple = true;
        for (let fi = 0; fi < def.fields.length; fi++) {
          if (def.fields[fi]!.name !== `_${fi}`) {
            isTuple = false;
            break;
          }
        }
        if (!isTuple) continue;
        // Only match when the tuple has at least as many fields as the pattern
        // consumes — fewer fields can't fulfill the binding element count.
        if (def.fields.length < pattern.elements.length) continue;

        const tupType: ValType = { kind: "ref_null", typeIdx: ti };
        const tupleLocal = allocLocal(fctx, `__dparam_tup_${ti}_${fctx.locals.length}`, tupType);

        // Build the fast-path body by swapping fctx.body so a recursive
        // destructureParamArray call emits into the conditional branch instead
        // of the outer function.
        //
        // #1314 — use pushBody/popBody (instead of a manual `fctx.body =`
        // swap with `savedBody` held only as a JS local) so the outer buffer
        // is registered in `fctx.savedBodies` for the duration of the swap.
        // Without this, `shiftLateImportIndices` (triggered when the recursive
        // emit calls `compileExpression(initializer)` with a function-call
        // default like `[x = g()]`) walks `fctx.body` (= fastPathInstrs) and
        // `fctx.savedBodies` but misses the JS-local outer buffer. Calls
        // already emitted into the outer buffer keep stale `funcIdx` and
        // start pointing to whatever shifted in (typically an extern import,
        // which has the wrong arity → "not enough arguments on the stack").
        const savedBody = pushBody(fctx);
        const fastPathInstrs = fctx.body;
        try {
          fctx.body.push({ op: "local.get", index: anyTmp });
          fctx.body.push({ op: "ref.cast", typeIdx: ti });
          fctx.body.push({ op: "local.set", index: tupleLocal });
          destructureParamArray(ctx, fctx, tupleLocal, pattern, tupType, opts);
          fctx.body.push({ op: "i32.const", value: 1 });
          fctx.body.push({ op: "local.set", index: dstrDoneLocal });
        } finally {
          popBody(fctx, savedBody);
        }

        // Gate on dstrDone == 0 so later tuple-struct checks (and the main
        // externref logic below) don't re-run once one match has succeeded.
        const testInstrs: Instr[] = [
          { op: "local.get", index: anyTmp },
          { op: "ref.test", typeIdx: ti },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: fastPathInstrs,
            else: [],
          },
        ];

        fctx.body.push({ op: "local.get", index: dstrDoneLocal });
        fctx.body.push({ op: "i32.eqz" });
        fctx.body.push({
          op: "if",
          blockType: { kind: "empty" },
          then: testInstrs,
          else: [],
        });
      }

      // Gate the existing externref→vec conversion + iter fallback logic on
      // dstrDone == 0. If the fast path already destructured, skip all of it.
      // We redirect fctx.body to a buffer; after the existing code finishes, we
      // wrap the buffer in `if dstrDone == 0 { ... }` and append to the real body.
      //
      // #1314 — same fix as the tuple-struct swap above: use pushBody so the
      // outer `realBody` is registered in `fctx.savedBodies` and visible to
      // `shiftLateImportIndices`. The downstream `ensureLateImport` calls
      // (lines below for `__extern_length`, `__extern_get_idx`,
      // `__array_from_iter`) trigger shifts that walk the savedBodies stack;
      // without pushBody, calls already emitted into `realBody` retained
      // stale `funcIdx` and pointed to the wrong function after the shift.
      const realBody = pushBody(fctx);
      const externrefLegacyBody = fctx.body;

      // Try direct cast to __vec_externref first (cheapest path)
      fctx.body.push({ op: "local.get", index: anyTmp });
      fctx.body.push({ op: "ref.test", typeIdx: extVecIdx });

      const directCastInstrs: Instr[] = [
        { op: "local.get", index: anyTmp },
        { op: "ref.cast", typeIdx: extVecIdx },
        { op: "local.set", index: resultLocal },
      ];

      // Pre-register fallback host imports BEFORE building convertInstrs, so that
      // any function index shifts from late imports are visible to boxToExternref
      // calls inside the vec-type conversion loop below. (#825)
      //
      // (#1890 / late-shift class) We deliberately do NOT capture the returned
      // funcIdx here: the `convertInstrs` loop below runs `boxToExternref` →
      // `addUnionImports`, which shifts every defined-function index, so any index
      // captured now would go stale. We re-resolve all three by name from funcMap
      // *after* that loop, just before baking them into call instructions. Only
      // the *presence* of these imports matters at this point.
      ensureLateImport(ctx, "__extern_length", [{ kind: "externref" }], [{ kind: "f64" }]);
      flushLateImportShifts(ctx, fctx);
      ensureLateImport(ctx, "__extern_get_idx", [{ kind: "externref" }, { kind: "f64" }], [{ kind: "externref" }]);
      flushLateImportShifts(ctx, fctx);
      // __array_from_iter_n materializes iterables (generators, sets, custom
      // @@iterator) so __extern_length / __extern_get_idx operate on a real
      // array. Throws from iterator .next() propagate (spec-compliant for
      // throwing iterators, #1150). The f64 step-count bounds consumption:
      // no-rest patterns consume EXACTLY elements.length steps; rest patterns
      // pass -1 → unbounded drain, byte-identical to legacy __array_from_iter
      // and preserving its IteratorClose tuning (#1219, #1592).
      const fbIterStepCount = patternIteratorStepCount(pattern.elements);
      // (#2904) Standalone/WASI are host-free: instead of leaking the JS-host
      // `env::__array_from_iter_n` import (which breaks zero-import
      // instantiation), register a NATIVE `__array_from_iter_n` that drains the
      // source through the existing native `__iterator` / `__iterator_next`
      // runtime into a `__vec_externref` — byte-identical for the downstream
      // `__extern_length` / `__extern_get_idx` reads below. JS-host mode keeps
      // the import (byte-identical).
      // (#3643 Slice A) §8.6.2 `BindingPattern : ArrayBindingPattern` performs
      // GetIterator (§7.4.2) on the RHS, which throws TypeError for a
      // non-iterable — `var [p] = {a:1}` must throw, not bind `undefined`.
      // The non-strict `__array_from_iter_n` falls through to the host
      // `Array.from(obj)` array-like fallback, which answers `[]`, so every
      // array-pattern form (single, multi, rest, param, array-like RHS)
      // silently bound `undefined`. Array SPREAD was already correct because it
      // uses the STRICT unbounded drain; destructuring is the arm that was never
      // wired to strictness. Use the strict bounded twin here.
      //
      // Standalone/WASI keep the native `__array_from_iter_n`: there is no
      // native strict arm yet, and emitting `env::__array_from_iter_n_strict`
      // would leak a host import and break zero-import instantiation (#2904).
      // The host-free lane therefore keeps its measured pre-existing behaviour —
      // this slice is host-lane only by construction, with the native strict arm
      // left as an explicit follow-up.
      const fbIterName = ctx.standalone || ctx.wasi ? "__array_from_iter_n" : "__array_from_iter_n_strict";
      if (ctx.standalone || ctx.wasi) {
        ensureNativeArrayFromIterN(ctx);
      } else {
        ensureLateImport(ctx, fbIterName, [{ kind: "externref" }, { kind: "f64" }], [{ kind: "externref" }]);
      }
      flushLateImportShifts(ctx, fctx);

      // Else: try each other known vec type and convert element-by-element
      const convertInstrs: Instr[] = [];
      for (const [key, vecIdx] of ctx.vecTypeMap) {
        if (vecIdx === extVecIdx) continue; // already handled
        const vecDef = ctx.mod.types[vecIdx];
        if (!vecDef || vecDef.kind !== "struct") continue;
        const dataField = vecDef.fields[1];
        if (!dataField || dataField.name !== "data") continue;
        const srcArrTypeIdx = (dataField.type as { typeIdx: number }).typeIdx;
        // (#2669) The real backing-store element type drives boxing/conversion —
        // a `ref_*` keyed vec stores its (boxed) elements as externref, so the
        // string key would mis-trigger `extern.convert_any` on an externref.
        const srcArrDef = ctx.mod.types[srcArrTypeIdx];
        const srcElemType: ValType | undefined =
          srcArrDef && srcArrDef.kind === "array" ? (srcArrDef.element as ValType) : undefined;

        const cvtTmp = allocLocal(fctx, `__dparam_src_${key}_${fctx.locals.length}`, {
          kind: "ref_null",
          typeIdx: vecIdx,
        });
        const lenTmp = allocLocal(fctx, `__dparam_len_${key}_${fctx.locals.length}`, { kind: "i32" });
        const dstArrTmp = allocLocal(fctx, `__dparam_darr_${key}_${fctx.locals.length}`, {
          kind: "ref",
          typeIdx: extArrTypeIdx,
        });
        const idxTmp = allocLocal(fctx, `__dparam_idx_${key}_${fctx.locals.length}`, { kind: "i32" });

        const thenInstrs: Instr[] = [
          // Cast and get length
          { op: "local.get", index: anyTmp },
          { op: "ref.cast", typeIdx: vecIdx },
          { op: "local.set", index: cvtTmp },
          { op: "local.get", index: cvtTmp },
          { op: "struct.get", typeIdx: vecIdx, fieldIdx: 0 }, // length
          { op: "local.set", index: lenTmp },
          // Create new externref array
          { op: "local.get", index: lenTmp },
          { op: "array.new_default", typeIdx: extArrTypeIdx },
          { op: "local.set", index: dstArrTmp },
          // Loop: copy elements with boxing
          { op: "i32.const", value: 0 },
          { op: "local.set", index: idxTmp },
          {
            op: "block",
            blockType: { kind: "empty" },
            body: [
              {
                op: "loop",
                blockType: { kind: "empty" },
                body: [
                  // if idx >= len, break
                  { op: "local.get", index: idxTmp },
                  { op: "local.get", index: lenTmp },
                  { op: "i32.ge_s" },
                  { op: "br_if", depth: 1 },
                  // dstArr[idx] = extern.convert_any(srcArr[idx])
                  { op: "local.get", index: dstArrTmp },
                  { op: "local.get", index: idxTmp },
                  { op: "local.get", index: cvtTmp },
                  { op: "struct.get", typeIdx: vecIdx, fieldIdx: 1 }, // src data
                  { op: "local.get", index: idxTmp },
                  // (#3024) Packed i8/i16 backing arrays (typed-array / resizable-
                  // ArrayBuffer byte stores) are STORAGE-only: a plain `array.get`
                  // is invalid Wasm ("has packed type … use array.get_s/_u"). Read
                  // packed carriers unsigned-extended (`array.get_u`); `boxToExternref`
                  // then f64-boxes the zero-extended i32. Non-packed carriers keep the
                  // byte-identical plain `array.get`.
                  {
                    op:
                      srcElemType && (srcElemType.kind === "i8" || srcElemType.kind === "i16")
                        ? "array.get_u"
                        : "array.get",
                    typeIdx: srcArrTypeIdx,
                  },
                  // Box primitive types before storing as externref
                  ...boxToExternref(ctx, key, srcElemType, fctx),
                  { op: "array.set", typeIdx: extArrTypeIdx },
                  // idx++
                  { op: "local.get", index: idxTmp },
                  { op: "i32.const", value: 1 },
                  { op: "i32.add" },
                  { op: "local.set", index: idxTmp },
                  { op: "br", depth: 0 },
                ],
              },
            ],
          },
          // Create __vec_externref: struct.new(len, dstArr)
          { op: "local.get", index: lenTmp },
          { op: "local.get", index: dstArrTmp },
          { op: "struct.new", typeIdx: extVecIdx },
          { op: "local.set", index: resultLocal },
        ];

        convertInstrs.push({ op: "local.get", index: anyTmp });
        convertInstrs.push({ op: "ref.test", typeIdx: vecIdx });
        convertInstrs.push({ op: "if", blockType: { kind: "empty" }, then: thenInstrs, else: [] });
      }

      // Fallback: if no Wasm vec type matched, the externref is a plain JS array/iterable.
      // Materialize via Array.from first so iterator protocol runs (generators, custom
      // @@iterator); then walk with __extern_length + __extern_get_idx. (#825, #1150)
      //
      // (#1890 / late-shift class) RE-RESOLVE the three fallback funcIdx by name
      // before baking them into call instructions below. They were captured above
      // (lines ~1012/1014/1029), but the `convertInstrs` loop just ran
      // `boxToExternref` → `addUnionImports`, which adds func imports and shifts
      // EVERY defined-function index. Under standalone/WASI these names resolve to
      // DEFINED helpers (via addUnionImportsViaRegistry / ensureObjectRuntime), so
      // their captured indices are now stale-low → the `call`s would target the
      // freshly-inserted import (invalid Wasm). funcMap holds the post-shift truth;
      // re-reading by name is the fix (idempotent — no new import is added here).
      const fbLenFnFinal = ctx.funcMap.get("__extern_length");
      const fbGetIdxFnFinal = ctx.funcMap.get("__extern_get_idx");
      const fbIterFnFinal = ctx.funcMap.get(fbIterName);
      if (fbLenFnFinal !== undefined && fbGetIdxFnFinal !== undefined && fbIterFnFinal !== undefined) {
        const fbMatTmp = allocLocal(fctx, `__dparam_fb_mat_${fctx.locals.length}`, { kind: "externref" });
        const fbLenTmp = allocLocal(fctx, `__dparam_fb_len_${fctx.locals.length}`, { kind: "i32" });
        const fbArrTmp = allocLocal(fctx, `__dparam_fb_arr_${fctx.locals.length}`, {
          kind: "ref",
          typeIdx: extArrTypeIdx,
        });
        const fbIdxTmp = allocLocal(fctx, `__dparam_fb_idx_${fctx.locals.length}`, { kind: "i32" });

        const fallbackInstrs: Instr[] = [
          // materialized = __array_from_iter_n(param, stepCount) — throws from
          // iterator .next() propagate; stepCount bounds the drain (#1592).
          { op: "local.get", index: paramIdx },
          { op: "f64.const", value: fbIterStepCount },
          { op: "call", funcIdx: fbIterFnFinal },
          { op: "local.set", index: fbMatTmp },
          // len = i32(__extern_length(materialized))
          { op: "local.get", index: fbMatTmp },
          { op: "call", funcIdx: fbLenFnFinal },
          { op: "i32.trunc_sat_f64_s" },
          { op: "local.set", index: fbLenTmp },
          // arr = array.new_default(len)
          { op: "local.get", index: fbLenTmp },
          { op: "array.new_default", typeIdx: extArrTypeIdx },
          { op: "local.set", index: fbArrTmp },
          // idx = 0
          { op: "i32.const", value: 0 },
          { op: "local.set", index: fbIdxTmp },
          // loop: copy elements
          {
            op: "block",
            blockType: { kind: "empty" },
            body: [
              {
                op: "loop",
                blockType: { kind: "empty" },
                body: [
                  // if idx >= len, break
                  { op: "local.get", index: fbIdxTmp },
                  { op: "local.get", index: fbLenTmp },
                  { op: "i32.ge_s" },
                  { op: "br_if", depth: 1 },
                  // arr[idx] = __extern_get_idx(materialized, f64(idx))
                  { op: "local.get", index: fbArrTmp },
                  { op: "local.get", index: fbIdxTmp },
                  { op: "local.get", index: fbMatTmp },
                  { op: "local.get", index: fbIdxTmp },
                  { op: "f64.convert_i32_s" },
                  { op: "call", funcIdx: fbGetIdxFnFinal },
                  { op: "array.set", typeIdx: extArrTypeIdx },
                  // idx++
                  { op: "local.get", index: fbIdxTmp },
                  { op: "i32.const", value: 1 },
                  { op: "i32.add" },
                  { op: "local.set", index: fbIdxTmp },
                  { op: "br", depth: 0 },
                ],
              },
            ],
          },
          // Build vec_externref: struct.new(len, arr)
          { op: "local.get", index: fbLenTmp },
          { op: "local.get", index: fbArrTmp },
          { op: "struct.new", typeIdx: extVecIdx },
          { op: "local.set", index: resultLocal },
        ];

        // Only run fallback if resultLocal is still null (no vec type matched)
        convertInstrs.push({ op: "local.get", index: resultLocal });
        convertInstrs.push({ op: "ref.is_null" });
        convertInstrs.push({
          op: "if",
          blockType: { kind: "empty" },
          then: fallbackInstrs,
          else: [],
        });
      }

      fctx.body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: directCastInstrs,
        else: convertInstrs,
      });

      // Fallback: if none of the known vec types matched, treat the externref
      // as a JS array/iterable and build a fresh __vec_externref from it via
      // __extern_length/__extern_get. Unblocks Wasm-to-Wasm rest-destructuring
      // after setExports — __make_iterable unconditionally converts vec structs
      // to JS arrays at the call boundary, which would otherwise trap here (#1135).
      const extVecInfo = getVecInfo(ctx, extVecIdx);
      if (extVecInfo) {
        const fallbackInstrs = buildVecFromExternref(ctx, fctx, paramIdx, extVecIdx, extVecInfo);
        fctx.body.push({ op: "local.get", index: resultLocal });
        fctx.body.push({ op: "ref.is_null" });
        fctx.body.push({
          op: "if",
          blockType: { kind: "empty" },
          then: [...fallbackInstrs, { op: "local.set", index: resultLocal }],
          else: [],
        });
      }

      // Now destructure from the converted vec_externref.
      destructureParamArray(ctx, fctx, resultLocal, pattern, convertedType, opts);

      // Close the #862 tuple-struct fast-path gate: wrap everything since the
      // dstrDone sentinel was initialised in `if dstrDone == 0 { ... }` and
      // splice back into the real body.
      // #1314 — popBody mirrors the pushBody above (was: `fctx.body = realBody`).
      popBody(fctx, realBody);
      fctx.body.push({ op: "local.get", index: dstrDoneLocal });
      fctx.body.push({ op: "i32.eqz" });
      fctx.body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: externrefLegacyBody,
        else: [],
      });
      return;
    }
    // Cannot destructure a non-ref type — register locals with defaults
    for (const element of pattern.elements) {
      if (ts.isOmittedExpression(element)) continue;
      if (ts.isIdentifier((element as ts.BindingElement).name)) {
        const name = ((element as ts.BindingElement).name as ts.Identifier).text;
        if (!fctx.localMap.has(name)) {
          const elemType = ctx.checker.getTypeAtLocation(element);
          // (#3315) Route through resolveBindingElementType (NOT bare
          // resolveWasmType) so parameter array-pattern elements without a
          // default get the undefined-preserving externref rep — keeping the
          // local's type consistent regardless of which allocation site runs
          // first (ensureBindingLocals applies the same rule).
          allocLocal(
            fctx,
            name,
            resolveBindingElementType(element as ts.BindingElement, elemType, (t) => resolveWasmType(ctx, t)),
          );
          if (isUndefWidenedBindingElement(element as ts.BindingElement, resolveWasmType(ctx, elemType))) {
            (fctx.undefWidenedLocals ??= new Set()).add(name);
          }
        }
      }
    }
    return;
  }

  const vecTypeIdx = (paramType as { typeIdx: number }).typeIdx;
  const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
  const arrDef = ctx.mod.types[arrTypeIdx];
  if (!arrDef || arrDef.kind !== "array") {
    // Not a vec array — check if it's a tuple struct (fields named _0, _1, ...)
    const tupleDef = ctx.mod.types[vecTypeIdx];
    if (tupleDef && tupleDef.kind === "struct" && tupleDef.fields.length > 0 && tupleDef.fields[0]!.name === "_0") {
      // Tuple struct destructuring: extract positional fields via struct.get
      // Always treat as nullable — callers may pass empty/mismatched arrays that
      // compile to ref.null even when the declared type is non-nullable ref (#852).
      const isNullable = paramType.kind === "ref_null" || paramType.kind === "ref";

      // Pre-allocate all binding locals
      ensureBindingLocals(ctx, fctx, pattern);

      // Pre-warm the null-guard message before populating the detached
      // `destructInstrs` buffer — see the vec path below for the rationale
      // (#1553d). Avoids a post-hoc global-index fixup missing the buffer.
      if (isNullable && pattern.elements.length > 0) {
        addStringConstantGlobal(ctx, "Cannot destructure 'null' or 'undefined'");
      }
      let savedBody: Instr[] | undefined;
      let destructInstrs: Instr[] = [];
      if (isNullable) {
        // Keep both sides of the body swap reachable to index fixups. Late
        // imports can be triggered while emitting `destructInstrs`; callers such
        // as the externref conversion path have already populated the previous
        // body with call indices that must shift too (#1891).
        savedBody = pushBody(fctx);
        destructInstrs = fctx.body;
      }

      for (let i = 0; i < pattern.elements.length; i++) {
        const element = pattern.elements[i]!;
        if (ts.isOmittedExpression(element)) continue;
        if (i >= tupleDef.fields.length) break; // more bindings than tuple fields

        const fieldType = tupleDef.fields[i]!.type;

        // Handle nested binding patterns
        if (
          ts.isBindingElement(element) &&
          (ts.isObjectBindingPattern(element.name) || ts.isArrayBindingPattern(element.name))
        ) {
          const tmpLocal = allocLocal(fctx, `__dparam_${fctx.locals.length}`, fieldType);
          fctx.body.push({ op: "local.get", index: paramIdx });
          fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: i });
          fctx.body.push({ op: "local.set", index: tmpLocal });
          // Handle default initializer for tuple destructuring (#794)
          if (element.initializer) {
            (ctx as any)._arrayLiteralForceVec = true;
            try {
              emitNestedBindingDefault(ctx, fctx, tmpLocal, fieldType, element.initializer);
            } finally {
              (ctx as any)._arrayLiteralForceVec = false;
            }
          }
          if (ts.isObjectBindingPattern(element.name)) {
            destructureParamObject(ctx, fctx, tmpLocal, element.name, fieldType, opts);
          } else {
            destructureParamArray(ctx, fctx, tmpLocal, element.name, fieldType, opts);
          }
          continue;
        }

        if (!ts.isIdentifier(element.name)) continue;
        const localName = element.name.text;
        if (!fctx.localMap.has(localName)) {
          allocLocal(fctx, localName, fieldType);
        }
        const localIdx = fctx.localMap.get(localName)!;
        const localType = getLocalType(fctx, localIdx);
        // (#2574) When the tuple FIELD is f64 (it carries the sNaN "undefined"
        // sentinel for an `undefined`/hole element) but the BINDING local is a
        // wider type (e.g. `externref` for an `any` binding) AND there is a
        // default, the f64→local coercion via `__box_number` turns the sentinel
        // into a NaN-NUMBER, after which the externref default check
        // (`__extern_is_undefined`, deliberately not `ref.is_null`) sees a number
        // → the default never fires (`const [a=9] = [undefined]` kept NaN). Run
        // the default check on the RAW f64 field FIRST (its sNaN-sentinel arm),
        // applying the default as f64, THEN coerce to the local type — so the
        // sentinel is consumed before the lossy box. Only when field=f64,
        // local≠f64, and there's an initializer; the value-present and no-default
        // paths keep the existing coerce.
        const fieldIsSentinelF64 =
          fieldType.kind === "f64" &&
          ts.isBindingElement(element) &&
          element.initializer !== undefined &&
          localType !== undefined &&
          !valTypesMatch(fieldType, localType);
        if (fieldIsSentinelF64) {
          const f64Tmp = allocLocal(fctx, `__dflt_f64_${fctx.locals.length}`, { kind: "f64" });
          // Push the raw f64 field on the stack; `emitDefaultValueCheck` (f64 arm)
          // consumes it, applies the default on the sNaN sentinel, and stores the
          // value-or-default into `f64Tmp`.
          fctx.body.push({ op: "local.get", index: paramIdx });
          fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: i });
          emitDefaultValueCheck(ctx, fctx, { kind: "f64" }, f64Tmp, element.initializer!);
          // coerce the resolved f64 to the local's declared type.
          fctx.body.push({ op: "local.get", index: f64Tmp });
          coerceType(ctx, fctx, { kind: "f64" }, localType!);
          fctx.body.push({ op: "local.set", index: localIdx });
          if (isDecl) emitLocalTdzInit(fctx, localName);
          continue;
        }
        // (#2756) An identifier element with a default whose tuple FIELD is a
        // nullable ref (`ref`/`ref_null`) must run the null→default check BEFORE
        // any field→local coercion. The old path coerced the raw field up front;
        // for a `ref_null`→`ref` (non-null) local that coercion is a
        // `ref.as_non_null`, which TRAPS on a wasm-null (empty/absent) slot
        // *before* the default could fire — e.g. `let [c = {a:1}] = []` (an empty
        // array compiles to a 1-tuple with a null `_0`). `emitDefaultValueCheck`
        // tees the field, checks `ref.is_null`, applies the default in the
        // missing arm, and coerces to the local type ONLY in the value-present
        // arm — so a null/absent element flows to the default instead of trapping.
        // Numeric/array-literal defaults were already safe (f64 sentinel / vec
        // ref handled elsewhere); this targets the object/class heap-default case
        // (the fn-name-class test262 cluster). Non-ref fields keep the prior path.
        const refFieldWithDefault =
          ts.isBindingElement(element) &&
          element.initializer !== undefined &&
          (fieldType.kind === "ref" || fieldType.kind === "ref_null");
        fctx.body.push({ op: "local.get", index: paramIdx });
        fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: i });
        if (refFieldWithDefault) {
          emitDefaultValueCheck(ctx, fctx, fieldType, localIdx, element.initializer!, localType);
          if (isDecl) emitLocalTdzInit(fctx, localName);
          continue;
        }
        // Coerce struct field type to local's declared type if they differ (#658)
        if (localType && !valTypesMatch(fieldType, localType)) {
          coerceType(ctx, fctx, fieldType, localType);
        }
        fctx.body.push({ op: "local.set", index: localIdx });

        // Handle element-level default initializer (e.g. [x = 23] in destructuring)
        if (ts.isBindingElement(element) && element.initializer) {
          const effType = localType || fieldType;
          emitNestedBindingDefault(ctx, fctx, localIdx, effType, element.initializer);
        }
        if (isDecl) emitLocalTdzInit(fctx, localName);
      }

      // Close null guard — throw TypeError when null (JS spec)
      if (isNullable) {
        popBody(fctx, savedBody!);
        if (destructInstrs.length > 0) {
          // When param is null (e.g. empty array cast failed), apply element defaults
          const nullDefaultInstrs: Instr[] = [];
          for (const element of pattern.elements) {
            if (ts.isOmittedExpression(element)) continue;
            if (!ts.isBindingElement(element) || !element.initializer) continue;
            if (!ts.isIdentifier(element.name)) continue;
            const localName = element.name.text;
            const localIdx = fctx.localMap.get(localName);
            if (localIdx === undefined) continue;
            const localType = getLocalType(fctx, localIdx);
            if (!localType) continue;
            // Compile the default value into the null-path
            const prevBody = fctx.body;
            fctx.body = nullDefaultInstrs;
            compileExpression(ctx, fctx, element.initializer, localType);
            fctx.body.push({ op: "local.set", index: localIdx });
            if (isDecl) emitLocalTdzInit(fctx, localName);
            fctx.body = prevBody;
          }
          fctx.body.push({ op: "local.get", index: paramIdx });
          fctx.body.push({ op: "ref.is_null" });
          fctx.body.push({
            op: "if",
            blockType: { kind: "empty" },
            then: nullDefaultInstrs.length > 0 ? nullDefaultInstrs : buildDestructureNullThrow(ctx, fctx),
            else: destructInstrs,
          });
        }
      }
      return;
    }

    // Not an array and not a tuple — register locals with defaults
    for (const element of pattern.elements) {
      if (ts.isOmittedExpression(element)) continue;
      if (ts.isIdentifier((element as ts.BindingElement).name)) {
        const name = ((element as ts.BindingElement).name as ts.Identifier).text;
        if (!fctx.localMap.has(name)) {
          const elemType = ctx.checker.getTypeAtLocation(element);
          // (#3315) Route through resolveBindingElementType (NOT bare
          // resolveWasmType) so parameter array-pattern elements without a
          // default get the undefined-preserving externref rep — keeping the
          // local's type consistent regardless of which allocation site runs
          // first (ensureBindingLocals applies the same rule).
          allocLocal(
            fctx,
            name,
            resolveBindingElementType(element as ts.BindingElement, elemType, (t) => resolveWasmType(ctx, t)),
          );
          if (isUndefWidenedBindingElement(element as ts.BindingElement, resolveWasmType(ctx, elemType))) {
            (fctx.undefWidenedLocals ??= new Set()).add(name);
          }
        }
      }
    }
    return;
  }

  const elemType = arrDef.element;

  // Pre-allocate all binding locals so they exist even when param is null
  ensureBindingLocals(ctx, fctx, pattern);

  // Null guard: wrap destructuring in if-not-null for ref params.
  // Always treat as nullable — callers may pass empty/mismatched arrays that
  // compile to ref.null even when the declared type is non-nullable ref (#852).
  const isNullable = paramType.kind === "ref_null" || paramType.kind === "ref";
  // Pre-register the null-guard TypeError message so that adding it does not
  // trigger a global-index fixup AFTER the (detached) `destructInstrs` buffer
  // is populated (#1553d). `buildDestructureNullThrow` calls
  // `addStringConstantGlobal`, which inserts an import global and shifts every
  // existing `global.get`/`global.set` index. When that fired during the
  // null-guard close, `destructInstrs` was neither `fctx.body` nor in
  // `fctx.savedBodies` (it lives only inside the not-yet-pushed `if.else`), so
  // a default like `[x = g]` that reads a module global kept a stale index —
  // it pointed at the freshly-added string-constant import (externref) instead
  // of the intended f64 global. Warming the constant up front makes the close
  // a no-op for global indices.
  if (isNullable && pattern.elements.length > 0) {
    addStringConstantGlobal(ctx, "Cannot destructure 'null' or 'undefined'");
  }
  let savedBody: Instr[] | undefined;
  let destructInstrs: Instr[] = [];
  if (isNullable) {
    // Keep both sides of the body swap reachable to global/late-import index
    // fixups. `destructInstrs` is the active body, while the saved body may
    // already contain call indices emitted by the externref conversion fallback
    // before this recursive typed destructure runs (#1891).
    savedBody = pushBody(fctx);
    destructInstrs = fctx.body;
  }

  for (let i = 0; i < pattern.elements.length; i++) {
    const element = pattern.elements[i]!;
    if (ts.isOmittedExpression(element)) continue;

    // Handle nested binding patterns
    // Skip rest elements (dotDotDotToken) — those are handled below so the
    // rest vec is built before recursing into the nested pattern (e.g. [...[...x]]).
    if (
      ts.isBindingElement(element) &&
      !element.dotDotDotToken &&
      (ts.isObjectBindingPattern(element.name) || ts.isArrayBindingPattern(element.name))
    ) {
      // #1158/#1159 — when the nested pattern is itself empty-only, hold
      // the slot value as externref instead of coercing to vec/tuple. The
      // recursive call into the empty pattern then takes the
      // isPatternEmptyOnly short-circuit at line ~647 (no
      // __array_from_iter materialization).
      //
      // Important: this only applies when `element.name` is an array
      // binding pattern AND empty-only AND `elemType` is not externref
      // (when elemType is already externref the existing path is fine
      // — the extracted value flows directly into the recursive call).
      const isNestedEmptyArr =
        ts.isArrayBindingPattern(element.name) && isPatternEmptyOnly(element.name) && elemType.kind !== "externref";
      if (isNestedEmptyArr) {
        const externType: ValType = { kind: "externref" };
        const emptyTmp = allocLocal(fctx, `__dparam_emp_${fctx.locals.length}`, externType);
        // Read element as externref (or __get_undefined() for OOB):
        fctx.body.push({ op: "local.get", index: paramIdx });
        fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
        fctx.body.push({ op: "i32.const", value: i });
        emitBoundsCheckedArrayGetUndef(ctx, fctx, arrTypeIdx, elemType);
        // elemType is narrowed to non-externref at line 1179, so always coerce.
        coerceType(ctx, fctx, elemType, externType);
        fctx.body.push({ op: "local.set", index: emptyTmp });
        if (element.initializer) {
          // Default fires only when the slot is undefined — coerce the
          // initializer to externref WITHOUT going through vec/tuple
          // materialization (which would call __array_from_iter).
          emitNestedBindingDefault(ctx, fctx, emptyTmp, externType, element.initializer);
        }
        // Recurse with externref so the empty short-circuit fires.
        destructureParamArray(ctx, fctx, emptyTmp, element.name as ts.ArrayBindingPattern, externType, opts);
        continue;
      }
      const tmpLocal = allocLocal(fctx, `__dparam_${fctx.locals.length}`, elemType);
      fctx.body.push({ op: "local.get", index: paramIdx });
      fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 }); // get data
      fctx.body.push({ op: "i32.const", value: i });
      emitBoundsCheckedArrayGetUndef(ctx, fctx, arrTypeIdx, elemType); // #1016a
      fctx.body.push({ op: "local.set", index: tmpLocal });
      // Handle default initializer: [[x, y] = [4, 5]] — use default when element is null/undefined (#794)
      if (element.initializer) {
        (ctx as any)._arrayLiteralForceVec = true;
        try {
          emitNestedBindingDefault(ctx, fctx, tmpLocal, elemType, element.initializer);
        } finally {
          (ctx as any)._arrayLiteralForceVec = false;
        }
      }
      if (ts.isObjectBindingPattern(element.name)) {
        destructureParamObject(ctx, fctx, tmpLocal, element.name, elemType, opts);
      } else {
        destructureParamArray(ctx, fctx, tmpLocal, element.name, elemType, opts);
      }
      continue;
    }

    // Handle rest element: function([a, ...rest])
    if (element.dotDotDotToken) {
      // Compute rest length: max(0, param.length - i)
      const restLenLocal = allocLocal(fctx, `__rest_len_${fctx.locals.length}`, { kind: "i32" });
      // First compute len - i and store it
      fctx.body.push({ op: "local.get", index: paramIdx });
      fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 }); // length
      fctx.body.push({ op: "i32.const", value: i });
      fctx.body.push({ op: "i32.sub" });
      fctx.body.push({ op: "local.set", index: restLenLocal });
      // Clamp to 0 if negative: select(0, len-i, len-i < 0)
      fctx.body.push({ op: "i32.const", value: 0 });
      fctx.body.push({ op: "local.get", index: restLenLocal });
      fctx.body.push({ op: "local.get", index: restLenLocal });
      fctx.body.push({ op: "i32.const", value: 0 });
      fctx.body.push({ op: "i32.lt_s" });
      fctx.body.push({ op: "select" });
      fctx.body.push({ op: "local.set", index: restLenLocal });

      // Create new data array: array.new_default(restLen)
      const restArrLocal = allocLocal(fctx, `__rest_arr_${fctx.locals.length}`, { kind: "ref", typeIdx: arrTypeIdx });
      fctx.body.push({ op: "local.get", index: restLenLocal });
      fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
      fctx.body.push({ op: "local.set", index: restArrLocal });

      // #2031 — clamp the source offset to `min(i, srcLen)`. WasmGC
      // `array.copy` traps when `srcOffset > src.len` even for a zero-length
      // copy, so when the source is shorter than the fixed bindings (e.g.
      // `const [p, q = 9, ...rest] = [1]` ⇒ i=2 > len=1) the unclamped offset
      // `i` traps. Clamping to the length keeps `restLen=0` copies valid while
      // leaving longer sources (where `i <= len`) untouched.
      const srcOffsetLocal = allocLocal(fctx, `__rest_src_off_${fctx.locals.length}`, { kind: "i32" });
      fctx.body.push({ op: "local.get", index: paramIdx });
      fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 }); // srcLen
      fctx.body.push({ op: "local.set", index: srcOffsetLocal });
      // select(i, srcLen, i < srcLen) → min(i, srcLen)
      fctx.body.push({ op: "i32.const", value: i });
      fctx.body.push({ op: "local.get", index: srcOffsetLocal });
      fctx.body.push({ op: "i32.const", value: i });
      fctx.body.push({ op: "local.get", index: srcOffsetLocal });
      fctx.body.push({ op: "i32.lt_s" });
      fctx.body.push({ op: "select" });
      fctx.body.push({ op: "local.set", index: srcOffsetLocal });

      // array.copy(restArr, 0, srcData, min(i, srcLen), restLen)
      fctx.body.push({ op: "local.get", index: restArrLocal });
      fctx.body.push({ op: "i32.const", value: 0 });
      fctx.body.push({ op: "local.get", index: paramIdx });
      fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 }); // src data
      fctx.body.push({ op: "local.get", index: srcOffsetLocal });
      fctx.body.push({ op: "local.get", index: restLenLocal });
      fctx.body.push({ op: "array.copy", dstTypeIdx: arrTypeIdx, srcTypeIdx: arrTypeIdx });

      // Create new vec struct: struct.new(restLen, restArr)
      fctx.body.push({ op: "local.get", index: restLenLocal });
      fctx.body.push({ op: "local.get", index: restArrLocal });
      fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });

      if (ts.isIdentifier(element.name)) {
        const restName = element.name.text;
        // Only allocate if not already pre-allocated by ensureBindingLocals
        if (!fctx.localMap.has(restName)) {
          allocLocal(fctx, restName, paramType);
        } else {
          // ensureBindingLocals may have pre-allocated with a different vec type
          // (e.g. vec_f64 from TS type inference) while the externref conversion
          // path produces vec_externref. Reallocate with the correct type (#971).
          const existingIdx = fctx.localMap.get(restName)!;
          const slotIdx = existingIdx - fctx.params.length;
          if (slotIdx >= 0) {
            const slot = fctx.locals[slotIdx];
            if (slot && !valTypesMatch(slot.type, paramType)) {
              allocLocal(fctx, restName, paramType);
            }
          }
        }
        const restLocal = fctx.localMap.get(restName)!;
        fctx.body.push({ op: "local.set", index: restLocal });
        if (isDecl) emitLocalTdzInit(fctx, restName);
      } else if (ts.isArrayBindingPattern(element.name)) {
        // Nested rest with array pattern: function([...[a, b]])
        // The freshly-created struct is a non-null vec matching the outer vec type.
        const nestedType: ValType = { kind: "ref", typeIdx: vecTypeIdx };
        const nestedTmpLocal = allocLocal(fctx, `__rest_nested_${fctx.locals.length}`, nestedType);
        fctx.body.push({ op: "local.set", index: nestedTmpLocal });
        destructureParamArray(ctx, fctx, nestedTmpLocal, element.name, nestedType, opts);
      } else if (ts.isObjectBindingPattern(element.name)) {
        // Nested rest with object pattern: function([...{length}]) or [...{0:v}].
        // The rest array is array-like: `length` -> vec field 0, numeric keys ->
        // vec data array (#2844 shared helper, also used by the for-of lane).
        const nestedTmpLocal = allocLocal(fctx, `__rest_nested_${fctx.locals.length}`, {
          kind: "ref",
          typeIdx: vecTypeIdx,
        });
        fctx.body.push({ op: "local.set", index: nestedTmpLocal });
        emitObjectPatternRestFromVec(ctx, fctx, nestedTmpLocal, vecTypeIdx, arrTypeIdx, element.name, isDecl);
      } else {
        fctx.body.push({ op: "drop" });
      }
      continue;
    }

    if (!ts.isIdentifier(element.name)) continue;
    const localName = element.name.text;
    // Only allocate if not already pre-allocated by ensureBindingLocals
    if (!fctx.localMap.has(localName)) {
      allocLocal(fctx, localName, elemType);
    } else if (isDecl && elemType.kind === "externref" && !!element.initializer) {
      // #1553d — decl-mode parity with the retired externref-array path, which
      // allocated each binding local with the *element* type (externref) rather
      // than the TS-narrowed type. For an externref vec element the TS type can
      // narrow to a numeric (`let [x] = [null]` → `x: number | null`), and
      // coercing the externref into that numeric local unboxes a genuine `null`
      // to `0`, losing the null identity (`x === null` must hold). Re-type the
      // pre-allocated local to externref so the value survives unchanged. Param
      // mode keeps its fixed signature type and is untouched.
      const existing = getLocalType(fctx, fctx.localMap.get(localName)!);
      if (existing && existing.kind !== "externref") {
        allocLocal(fctx, localName, { kind: "externref" });
      }
    }
    const localIdx = fctx.localMap.get(localName)!;
    fctx.body.push({ op: "local.get", index: paramIdx });
    fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 }); // get data
    fctx.body.push({ op: "i32.const", value: i });
    emitBoundsCheckedArrayGetUndef(ctx, fctx, arrTypeIdx, elemType); // #1016a
    // Handle default initializer: [x = 23] — use default when element is null/undefined
    if (element.initializer) {
      const dfltTmpLocal = allocLocal(fctx, `__dparam_dflt_${fctx.locals.length}`, elemType);
      fctx.body.push({ op: "local.set", index: dfltTmpLocal });
      emitNestedBindingDefault(ctx, fctx, dfltTmpLocal, elemType, element.initializer);
      fctx.body.push({ op: "local.get", index: dfltTmpLocal });
    }
    // Coerce array element type to local's declared type if they differ (#658)
    const vecLocalType = getLocalType(fctx, localIdx);
    if (vecLocalType && !valTypesMatch(elemType, vecLocalType)) {
      if (!coerceArrayBindingExternrefToAnyValue(ctx, fctx, elemType, vecLocalType)) {
        coerceType(ctx, fctx, elemType, vecLocalType);
      }
    }
    fctx.body.push({ op: "local.set", index: localIdx });
    if (isDecl) emitLocalTdzInit(fctx, localName);
  }

  // Close null guard — throw TypeError when null (JS spec)
  // Skip for empty `[]` patterns (#225).
  if (isNullable) {
    popBody(fctx, savedBody!);
    if (destructInstrs.length > 0 && pattern.elements.length > 0) {
      fctx.body.push({ op: "local.get", index: paramIdx });
      fctx.body.push({ op: "ref.is_null" });
      fctx.body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: buildDestructureNullThrow(ctx, fctx),
        else: destructInstrs,
      });
    } else if (destructInstrs.length > 0) {
      fctx.body.push(...destructInstrs);
    }
  }
}

/**
 * Cache string literal thunk calls in locals for the given function.
 *
 * After a function body has been compiled, this scans all instructions
 * (including nested blocks/loops/ifs) for `call` instructions that invoke
 * string literal thunks (__str_N).  For each unique thunk found it:
 *   1. Allocates an `externref` local to hold the cached value.
 *   2. Prepends `call $__str_N` + `local.set $cached` at function entry.
 *   3. Replaces every matching `call` in the body with `local.get $cached`.
 *
 * This avoids repeated import calls for the same string literal, which is
 * especially beneficial inside loops.
 */
