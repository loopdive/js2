// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Literal compilation for js2wasm — object, array, tuple, and symbol literals.
 *
 * Extracted from expressions.ts (issue #688, step 7).
 *
 * Functions in this file:
 *   - ensureComputedPropertyFields, compileObjectLiteral
 *   - resolveConstantExpression, resolvePropertyNameText
 *   - resolveWellKnownSymbol, getWellKnownSymbolId, ensureSymbolCounter, compileSymbolCall
 *   - resolveComputedKeyExpression, resolveAccessorPropName
 *   - compileWidenedEmptyObject, compileObjectLiteralForStruct
 *   - compileTupleLiteral, compileArrayLiteral, compileArrayConstructorCall
 */

import ts from "typescript";
import { hoistFunctionDeclarations } from "./statements/nested-declarations.js";
import { isStringType, isVoidType, unwrapPromiseType } from "../checker/type-mapper.js";
import type { FieldDef, Instr, StructTypeDef, ValType, WasmFunction } from "../ir/types.js";
import {
  collectMutatedCaptureNames,
  collectReferencedIdentifiers,
  collectWrittenIdentifiers,
  compileArrowAsCallback,
  compileArrowAsClosure,
  type SharedRefCellMap,
  emitMethodParamDefaults,
  emitObjectMethodAsClosure,
  genBodyReferencesSuper,
  promoteAccessorCapturesToGlobals,
} from "./closures.js";
import { emitAsyncGenerator, isAsyncGenDriveCandidate } from "./async-frame.js"; // (#3132 S2) obj-literal async-gen method drive
import { addFunctionOwnLocals } from "../ir/analysis/binding-info.js";
import { exactClassExpressionTypeName } from "./class-expression-identity.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { emitHoleSentinel } from "./array-holes.js"; // (#2001 S1)
import { f64HolesActive } from "./vec-f64-hole-presence.js"; // (#4491 T11)
import { HOLE_F64_BITS, UNDEF_F64_BITS } from "./value-tags.js"; // (#4491 T11)
import { ensureStrToCharVecHelper, stringConstantExternrefInstrs } from "./native-strings.js";
import { emitStandaloneIterableMaterialize } from "./iterator-native.js"; // (#3100 S5)
import { popBody, pushBody } from "./context/bodies.js";
import { reportError } from "./context/errors.js";
import { emptyBackingStoreInstrs } from "./empty-vec-store.js"; // (#3921) shared zero-length backing store
import { allocLocal, allocTempLocal, releaseTempLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext, OptionalParamInfo } from "./context/types.js";
import { isForeignEvalNode } from "./expressions/eval-source.js";
import { emitUndefined, patchStructNewForAddedField } from "./expressions/late-imports.js";
import { resolveStructName } from "./expressions/misc.js";
import { arrayIteratorOverrideGlobalIdx, emitArrayProtoIteratorDrive } from "./expressions/proto-override.js";
import { ensureObjVecBuilders } from "./object-runtime.js";
import { bodyNeedsArgumentsObject, needsImplicitArgumentsObject } from "./helpers/body-uses-arguments.js";
import { widenedVarKeyFromDecl } from "./widened-var-key.js";
import { isStrictFunction, isSimpleParameterList } from "./helpers/is-strict-function.js";
import { initializeFunctionPoisonPillContext } from "./function-poison-pill.js";
import { collectInstrs } from "./statements/shared.js";
import {
  cacheStringLiterals,
  destructureParamArray,
  destructureParamObject,
  ensureStructForType,
  extractConstantDefault,
  getOrRegisterTupleType,
  getTupleElementTypes,
  hoistLetConstWithTdz,
  hoistVarDeclarations,
  isTupleType,
  resolveWasmType,
} from "./index.js";
import { ensureExnTag, nextModuleGlobalIdx } from "./registry/imports.js";
import { buildTargetTaggedTry } from "../ir/try-table.js";
import {
  compileNativeGeneratorFunction,
  emitNativeGeneratorToVec,
  isNativeGeneratorCandidate,
  nativeGeneratorInfoForForOfSubject,
  registerNativeGenerator,
} from "./generators-native.js";
import { emitCollectionIteratorVec } from "./map-runtime.js";
import { emitSymbolDescStore, ensureNativeSymbolBoundaryBridge, usesNativeSymbolProvider } from "./symbol-native.js";
import { addFuncType, getArrTypeIdxFromVec, getOrRegisterVecType } from "./registry/types.js";
import {
  coerceType,
  compileExpression,
  compileStatement,
  emitArgumentsObject,
  ensureLateImport,
  flushLateImportShifts,
  registerMaterializeStructAsObject,
  registerResolveComputedKeyExpression,
  valTypesMatch,
  VOID_RESULT,
} from "./shared.js";
import { buildVecFromExternref, getVecInfo, pushDefaultValue } from "./type-coercion.js";
import { emitDrainCustomIterableToVec, isCustomIterable } from "./custom-iterable.js";
import {
  S5C_STRUCT_ACCESSOR_CLOSURE,
  buildAccessorClosure,
  ensureStructAccessorGlobal,
  isDefinePropertyReceiverLiteral,
} from "./struct-accessor-closure.js";
import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "./func-space.js"; // (#1916 S2 read chokepoint / S3b stable-regime minting)
import { registerCountedPushArray } from "./array-indexof-scan.js";
/**
 * Check if a TS expression is "undefined-like" — OmittedExpression (array hole),
 * undefined keyword, identifier `undefined`, void expression, or any of the
 * above wrapped in transparent expressions (`as T`, `<T>x`, `satisfies T`,
 * parentheses, non-null assertion `!`).
 *
 * Used to emit sNaN sentinels in tuple/array contexts so destructuring
 * default checks trigger correctly (#1024, #1553e).
 */
function _isUndefinedLike(node: ts.Node): boolean {
  // Unwrap transparent expressions so `undefined as any`, `(undefined)`,
  // `<any>undefined`, `undefined satisfies T`, `undefined!` all count.
  // (#1553e — explicit `undefined as any` is the common pattern in test262
  // for forcing the destructuring-default path on numeric arrays.)
  let n: ts.Node = node;
  while (
    ts.isAsExpression(n) ||
    ts.isTypeAssertionExpression(n) ||
    ts.isSatisfiesExpression(n) ||
    ts.isParenthesizedExpression(n) ||
    ts.isNonNullExpression(n)
  ) {
    n = (
      n as
        | ts.AsExpression
        | ts.TypeAssertion
        | ts.SatisfiesExpression
        | ts.ParenthesizedExpression
        | ts.NonNullExpression
    ).expression;
  }
  return (
    ts.isOmittedExpression(n) ||
    n.kind === ts.SyntaxKind.UndefinedKeyword ||
    (ts.isIdentifier(n) && n.text === "undefined") ||
    ts.isVoidExpression(n)
  );
}

// (#2769) Is this inner array literal `undefined`/`void`/hole-ONLY — i.e. it
// would naturally build an externref-backed vec (every element falls into the
// `_isUndefinedLike`/omitted branch of compileArrayLiteral) BUT
// `resolveWasmType(its TS type)` lowers it to a numeric (`__vec_i32`/`__vec_f64`)
// vec, so the OUTER literal coerces it and destroys the undefined/$Hole identity
// at construction? Used ONLY under the scoped `_forOfPreserveUndefElem` flag.
//
// Narrowly the undefined/hole-ONLY case: a HETEROGENEOUS inner like
// `[10, undefined]` already builds an `__vec_f64` via the existing sNaN-sentinel
// path (and the OUTER derives `__vec_f64` too → they match, no coercion), so
// re-keying THAT to externref would instead BREAK it (mismatched vec→vec
// coercion → NaN). Empty inners (`[]`) are out-of-bounds, handled by the
// existing default path — also excluded (length 0). Numeric/object literals like
// `[7]` return false → byte-identical numeric-vec backing.
function arrayLiteralIsUndefinedOrHoleOnly(arr: ts.ArrayLiteralExpression): boolean {
  if (arr.elements.length === 0) return false;
  return arr.elements.every((el) => ts.isOmittedExpression(el) || _isUndefinedLike(el));
}

/**
 * Is an array literal produced directly into an unconstrained `any` element
 * position? Accept bare `any` (an inner literal of `any[]`) and
 * `Array<any>`/`ReadonlyArray<any>` (the outer literal), but not typed unions.
 */
function arrayLiteralHasAnyElementContext(ctx: CodegenContext, arr: ts.ArrayLiteralExpression): boolean {
  const contextual = ctx.oracle.contextualFactOf(arr);
  return contextual?.kind === "any" || (contextual?.kind === "array" && contextual.element.kind === "any");
}

/**
 * Return the statically known own data-property names of an object literal.
 *
 * This is deliberately narrower than the full object-literal compiler: a
 * spread, method/accessor, or dynamic computed key returns `null`. Such a
 * literal cannot prove that it shares another literal's closed struct carrier,
 * so an array containing it must use the lossless externref element carrier.
 */
function staticObjectLiteralDataKeys(ctx: CodegenContext, expr: ts.ObjectLiteralExpression): string[] | null {
  const keys = new Set<string>();
  for (const prop of expr.properties) {
    if (!ts.isPropertyAssignment(prop) && !ts.isShorthandPropertyAssignment(prop)) return null;
    const key = resolvePropertyNameText(ctx, prop);
    if (key === undefined) return null;
    keys.add(key);
  }
  return [...keys].sort();
}

function unwrapObjectLiteralElement(expr: ts.Expression): ts.ObjectLiteralExpression | null {
  let current = expr;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return ts.isObjectLiteralExpression(current) ? current : null;
}

/**
 * Does a first-object array literal contain another element that cannot inhabit
 * the first object's exact closed struct? `compileArrayLiteral` historically
 * keyed the vec to element zero, then guarded-cast every later object to it.
 * Equal property names are not sufficient: `{params: {a: 1}}` and
 * `{params: {b: 2}}` have the same outer key but incompatible nested-field
 * carriers. Compare the resolved closed structs as well as the conservative
 * static key proof before retaining element zero's carrier.
 */
function hasIncompatibleObjectLiteralCarrier(
  ctx: CodegenContext,
  expr: ts.ArrayLiteralExpression,
  first: ts.Expression,
): boolean {
  const firstObject = unwrapObjectLiteralElement(first);
  if (!firstObject) return false;
  const firstKeys = staticObjectLiteralDataKeys(ctx, firstObject);
  if (!firstKeys) return true;
  const firstCarrier = resolveWasmType(ctx, ctx.checker.getTypeAtLocation(firstObject));

  for (const element of expr.elements) {
    if (ts.isOmittedExpression(element) || ts.isSpreadElement(element) || _isUndefinedLike(element)) continue;
    const object = unwrapObjectLiteralElement(element);
    if (!object) return true;
    const keys = staticObjectLiteralDataKeys(ctx, object);
    if (!keys || keys.length !== firstKeys.length || keys.some((key, index) => key !== firstKeys[index])) return true;
    const carrier = resolveWasmType(ctx, ctx.checker.getTypeAtLocation(object));
    if (!valTypesMatch(carrier, firstCarrier)) return true;
  }
  return false;
}

function unwrapArrayCarrierExpression(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function nestedArrayElementCarrier(ctx: CodegenContext, expr: ts.Expression): ValType | null {
  const nested = unwrapArrayCarrierExpression(expr);
  const nestedType = ctx.checker.getTypeAtLocation(nested);
  const symbol = (nestedType as ts.TypeReference).symbol ?? nestedType.symbol;
  if (symbol?.name !== "Array" && symbol?.name !== "ReadonlyArray") return null;
  const elementType = ctx.checker.getTypeArguments(nestedType as ts.TypeReference)[0];
  return elementType ? resolveWasmType(ctx, elementType) : null;
}

/**
 * Does an array-of-arrays require distinct inner element carriers? If so, the
 * parent must select a vec<externref> carrier for every inner array rather than
 * coercing later inner vecs through the first one's element representation.
 */
function hasHeterogeneousNestedArrayCarriers(
  ctx: CodegenContext,
  expr: ts.ArrayLiteralExpression,
  first: ts.Expression,
): boolean {
  const firstCarrier = nestedArrayElementCarrier(ctx, first);
  if (!firstCarrier) return false;

  for (const element of expr.elements) {
    if (ts.isOmittedExpression(element) || _isUndefinedLike(element)) continue;
    if (ts.isSpreadElement(element)) return false;
    const carrier = nestedArrayElementCarrier(ctx, element);
    if (!carrier) return false;
    if (!valTypesMatch(carrier, firstCarrier)) return true;
  }
  return false;
}

/** Exact synthetic classes constructed by every real element, when provable. */
function exactConstructedClassNames(ctx: CodegenContext, expr: ts.ArrayLiteralExpression): string[] | null {
  const names: string[] = [];
  for (const element of expr.elements) {
    if (ts.isOmittedExpression(element) || ts.isSpreadElement(element) || _isUndefinedLike(element)) return null;
    let value: ts.Expression = element;
    while (
      ts.isParenthesizedExpression(value) ||
      ts.isAsExpression(value) ||
      ts.isTypeAssertionExpression(value) ||
      ts.isSatisfiesExpression(value) ||
      ts.isNonNullExpression(value)
    ) {
      value = value.expression;
    }
    if (!ts.isNewExpression(value)) return null;
    const name = exactClassExpressionTypeName(ctx, ctx.checker.getTypeAtLocation(value.expression));
    if (!name) return null;
    names.push(name);
  }
  return names;
}

function classExtendsCarrier(ctx: CodegenContext, className: string, carrierName: string): boolean {
  const seen = new Set<string>();
  let current: string | undefined = className;
  while (current && !seen.has(current)) {
    if (current === carrierName) return true;
    seen.add(current);
    current = ctx.classParentMap.get(current);
  }
  return false;
}

/** Whether the selected ref is a genuine common base of all exact classes. */
function isCommonClassCarrier(ctx: CodegenContext, elemWasm: ValType, classNames: readonly string[]): boolean {
  if (elemWasm.kind !== "ref" && elemWasm.kind !== "ref_null") return false;
  for (const [carrierName, typeIdx] of ctx.structMap) {
    if (typeIdx !== elemWasm.typeIdx) continue;
    if (classNames.every((className) => classExtendsCarrier(ctx, className, carrierName))) return true;
  }
  return false;
}

/**
 * Ensure that a struct registered for an object literal includes fields for
 * computed property names that TypeScript cannot statically resolve.
 * When TS returns 0 properties (e.g. { [1+1]: 2 }), we resolve the computed
 * keys at compile time and create proper struct fields.
 */
export function ensureComputedPropertyFields(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.ObjectLiteralExpression,
  tsType: ts.Type,
): void {
  const existingName = resolveStructName(ctx, tsType);
  if (!existingName) return;
  const existingFields = ctx.structFields.get(existingName);
  if (!existingFields) return;

  // Collect all property assignments with their resolved names
  const resolvedProps: { name: string; valueExpr: ts.Expression }[] = [];
  for (const prop of expr.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    const propName = resolvePropertyNameText(ctx, prop);
    if (propName === undefined) continue;
    // Check if this field already exists in the struct
    if (existingFields.some((f) => f.name === propName)) continue;
    resolvedProps.push({ name: propName, valueExpr: prop.initializer });
  }

  if (resolvedProps.length === 0) return;

  // Need to add new fields. Create a replacement struct with the combined fields.
  const fields = [...existingFields];
  for (const rp of resolvedProps) {
    const propType = ctx.checker.getTypeAtLocation(rp.valueExpr);
    const wasmType = resolveWasmType(ctx, propType);
    fields.push({ name: rp.name, type: wasmType, mutable: true });
  }

  // Update the existing struct in-place
  const structTypeIdx = ctx.structMap.get(existingName)!;
  const typeDef = ctx.mod.types[structTypeIdx] as any;
  typeDef.fields = fields;
  ctx.structFields.set(existingName, fields);

  // Patch existing struct.new instructions for this type with defaults for new fields
  for (const rp of resolvedProps) {
    const propType = ctx.checker.getTypeAtLocation(rp.valueExpr);
    const wasmType = resolveWasmType(ctx, propType);
    patchStructNewForAddedField(ctx, fctx, structTypeIdx, wasmType);
  }
}

/**
 * Last-resort fallback: compile an object literal as an externref plain object via host imports.
 * Used when the TS type can't be mapped to a WasmGC struct (e.g., `{...null}`, `{...yield}`,
 * or bundled JS objects with types too wide for struct inference).
 *
 * Creates a new plain object via __new_plain_object, then:
 * - For spread assignments: calls __object_assign(target, source) to copy properties
 * - For regular properties: calls __set_prop(target, key, value)
 *
 * Returns externref, or null if the host import is unavailable.
 */
export function compileObjectLiteralAsExternref(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.ObjectLiteralExpression,
): ValType | null {
  const newObjIdx = ensureLateImport(ctx, "__new_plain_object", [], [{ kind: "externref" }]);
  flushLateImportShifts(ctx, fctx);
  if (newObjIdx === undefined) return null;

  // Create the target plain object
  fctx.body.push({ op: "call", funcIdx: newObjIdx });
  const objLocal = allocLocal(fctx, `__objlit_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: objLocal });

  for (const prop of expr.properties) {
    if (ts.isSpreadAssignment(prop)) {
      // Compile spread source and call __object_assign(target, [source]) -> target
      const srcType = compileExpression(ctx, fctx, prop.expression);
      if (srcType) {
        if (srcType.kind !== "externref") {
          coerceType(ctx, fctx, srcType, { kind: "externref" });
        }
        // Wrap source in a single-element sources list for __object_assign(target,
        // sources). Compatibility mode → JS array; native semantics → native $ObjVec (#1472
        // Phase B Slice 3 — native __object_assign iterates a $ObjVec).
        let arrNewIdx: number | undefined;
        let arrPushIdx: number | undefined;
        if (ctx.targetProfile.semanticProviders === "native-first") {
          const b = ensureObjVecBuilders(ctx);
          arrNewIdx = b.newIdx;
          arrPushIdx = b.pushIdx;
        } else {
          arrNewIdx = ensureLateImport(ctx, "__js_array_new", [], [{ kind: "externref" }]);
          arrPushIdx = ensureLateImport(ctx, "__js_array_push", [{ kind: "externref" }, { kind: "externref" }], []);
        }
        const assignIdx = ensureLateImport(
          ctx,
          "__object_assign",
          [{ kind: "externref" }, { kind: "externref" }],
          [{ kind: "externref" }],
        );
        flushLateImportShifts(ctx, fctx);
        if (assignIdx !== undefined && arrNewIdx !== undefined && arrPushIdx !== undefined) {
          const srcLocal = allocLocal(fctx, `__spread_src_${fctx.locals.length}`, { kind: "externref" });
          fctx.body.push({ op: "local.set", index: srcLocal });
          // Create sources array [source]
          fctx.body.push({ op: "call", funcIdx: arrNewIdx });
          const arrLocal = allocLocal(fctx, `__spread_arr_${fctx.locals.length}`, { kind: "externref" });
          fctx.body.push({ op: "local.set", index: arrLocal });
          fctx.body.push({ op: "local.get", index: arrLocal });
          fctx.body.push({ op: "local.get", index: srcLocal });
          fctx.body.push({ op: "call", funcIdx: arrPushIdx });
          // Call __object_assign(target, [source])
          fctx.body.push({ op: "local.get", index: objLocal });
          fctx.body.push({ op: "local.get", index: arrLocal });
          fctx.body.push({ op: "call", funcIdx: assignIdx });
          fctx.body.push({ op: "local.set", index: objLocal });
        }
      }
    }
    // (#1901) Named data properties — `key: value` and shorthand `{ x }`. Build
    // them onto the $Object via native __extern_set so a downstream string-key
    // read (`o.x`), method dispatch (`o.m()`), or ToPrimitive (valueOf/toString)
    // reads them through the $Object the existing native helpers already handle.
    // This is the construction-time route for an object literal flowing into an
    // any/externref/object contextual type (#1901 (iii)): the closed-struct path
    // would build a struct $Object's readers can't match (returns 0 / invalid
    // Wasm standalone). Methods are stored as their closure value (S2's
    // __apply_closure invokes them via __call_fn_method_N). Computed keys and
    // accessors are NOT handled here — those route to the accessor/host paths
    // upstream (compileObjectLiteralWithAccessors / the struct path) before this.
    else if (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop)) {
      const keyText = resolvePropertyNameText(ctx, prop);
      if (keyText === undefined) continue; // computed/symbol key — skip (handled upstream)
      const setIdx = ensureLateImport(
        ctx,
        "__extern_set",
        [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
        [],
      );
      flushLateImportShifts(ctx, fctx);
      if (setIdx === undefined) continue;
      // value: shorthand `{ x }` reads identifier x; `key: value` compiles the
      // initializer.
      const valueExpr = ts.isShorthandPropertyAssignment(prop)
        ? prop.name
        : (prop as ts.PropertyAssignment).initializer;
      // Nested object-literal value (`{x: {y: 5}}`): the inner literal has NO
      // contextual type, so the any-context gate in compileObjectLiteral would
      // route it to the closed-struct path — but it is being stored INTO a
      // `$Object`, so its reads come back through __extern_get and must be a
      // `$Object` too. Recurse at the construction site (where we KNOW the
      // destination representation) instead of widening the contextual-type
      // gate (which mis-fires on struct-consumed literals — the #1897 -45).
      const valType =
        ts.isObjectLiteralExpression(valueExpr) &&
        valueExpr.properties.length > 0 &&
        valueExpr.properties.every(
          (p) =>
            (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
            resolvePropertyNameText(ctx, p) !== undefined,
        )
          ? compileObjectLiteralAsExternref(ctx, fctx, valueExpr)
          : compileExpression(ctx, fctx, valueExpr, { kind: "externref" });
      if (valType === null) continue;
      if (valType.kind !== "externref") {
        coerceType(ctx, fctx, valType, { kind: "externref" });
      }
      const valLocal = allocLocal(fctx, `__objlit_v_${fctx.locals.length}`, { kind: "externref" });
      fctx.body.push({ op: "local.set", index: valLocal });
      // __extern_set(obj, "<key>", value)
      fctx.body.push({ op: "local.get", index: objLocal });
      addStringConstantGlobal(ctx, keyText);
      fctx.body.push(...stringConstantExternrefInstrs(ctx, keyText));
      fctx.body.push({ op: "local.get", index: valLocal });
      fctx.body.push({ op: "call", funcIdx: setIdx });
    }
    // (#3099) Method shorthand (`{ m() {…} }`) — materialize the method as a REAL
    // runtime own property so runtime-keyed consumers (`__extern_get`,
    // `Object.keys`, the `__proxy_*` trap reads of a shorthand handler, spread,
    // for-in) find it, exactly like the arrow-property arm above. Previously this
    // fell through (skipped), so a shorthand handler's traps silently forwarded
    // and `Object.keys`/`o[k]` missed the method. Mirrors the MethodDeclaration
    // arm in `compileObjectLiteralWithAccessors` (below): compile the method as a
    // closure via `emitObjectLiteralMethodFn` (standalone → host-free closure;
    // gc/host → `__make_*_callback` bridge) and store it with `__extern_set`. Only
    // PLAIN identifier/string/numeric names are handled here — computed/symbol
    // method keys route to the accessor/host path upstream, matching the
    // data-property arm above (which skips `keyText === undefined`).
    else if (ts.isMethodDeclaration(prop)) {
      let methodName: string | undefined;
      if (ts.isIdentifier(prop.name)) methodName = prop.name.text;
      else if (ts.isStringLiteral(prop.name)) methodName = prop.name.text;
      // Canonicalize a numeric method key (`{ 0x10() {} }` → "16") to match the
      // data-property arm's `resolvePropertyNameText`, so store and read agree.
      else if (ts.isNumericLiteral(prop.name)) methodName = String(Number(prop.name.text));
      if (methodName === undefined) continue; // computed/symbol key — handled upstream
      const setIdx = ensureLateImport(
        ctx,
        "__extern_set",
        [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
        [],
      );
      flushLateImportShifts(ctx, fctx);
      if (setIdx === undefined) continue;
      // Stack: [obj, key, closure] → __extern_set(obj, key, value).
      addStringConstantGlobal(ctx, methodName);
      fctx.body.push({ op: "local.get", index: objLocal });
      fctx.body.push(...stringConstantExternrefInstrs(ctx, methodName));
      const ok = emitObjectLiteralMethodFn(ctx, fctx, prop as unknown as ts.FunctionExpression);
      // On decline (e.g. generator/async shorthand `compileArrowAsClosure`
      // rejects — see issue note 2), store `undefined` to keep the stack balanced,
      // matching the sibling arm's `ref.null.extern` fallback.
      if (!ok) fctx.body.push({ op: "ref.null.extern" });
      fctx.body.push({ op: "call", funcIdx: setIdx });
    }
  }

  fctx.body.push({ op: "local.get", index: objLocal });
  return { kind: "externref" };
}

/**
 * (#2358) Reify a NOMINAL object struct (its ref already on the Wasm stack) into
 * a dynamic `$Object` externref, copying each field as an own-property — so the
 * native `__to_primitive` helper (which recognises only `$Object` via
 * `ref.test objectTypeIdx`) can reduce a typed object that has crossed the
 * externref boundary as an `any` value (e.g. an any-typed parameter, where the
 * concrete typeIdx is erased inside the callee). The struct-instance analogue of
 * `compileObjectLiteralAsExternref` (which builds the same `$Object` from AST
 * props): both go through `__new_plain_object` + `__extern_set`, so the resulting
 * object is read by the exact same native helpers.
 *
 * Returns true on success (struct consumed, `$Object` externref left on the
 * stack); false if it declined (nothing emitted — caller must fall back to
 * `extern.convert_any`). Declines when the struct type is unknown or the object
 * runtime helpers are unavailable.
 *
 * This is a value-semantics COPY: it does not preserve nominal reference
 * identity across the round-trip. The caller gates it to objects that carry a
 * user ToPrimitive method (`valueOf`/`@@toPrimitive`/`toString`), for which
 * value semantics suffice; plain data structs keep `extern.convert_any`.
 */
export function materializeStructAsDynamicObject(
  ctx: CodegenContext,
  fctx: FunctionContext,
  structTypeIdx: number,
  opts?: { skipInternalFields?: boolean },
): boolean {
  const structName = ctx.typeIdxToStructName.get(structTypeIdx);
  if (structName === undefined) return false;
  const allFields = ctx.structFields.get(structName);
  if (!allFields || allFields.length === 0) return false;

  // (#3222 C1) When materializing for own-property ENUMERATION (spread / object
  // rest in standalone), skip synthetic/internal slots (`__tag`, class brand,
  // method-table entries — every `__`-prefixed field) so they never surface as
  // own keys. This mirrors the `userFields` filter in `compileObjectKeysOrValues`
  // (object-ops.ts). Real own-enumerable data + method fields keep their struct
  // field index for the `struct.get` below. The default (no opts) copies ALL
  // fields, preserving the existing `__to_primitive` materialize behaviour.
  const fields = opts?.skipInternalFields
    ? allFields.map((f, i) => ({ f, i })).filter((e) => !e.f.name.startsWith("__"))
    : allFields.map((f, i) => ({ f, i }));
  if (fields.length === 0) {
    // Struct had only internal fields — still produce a valid empty $Object so
    // the caller's downstream enumeration path sees a proper open object.
    const newObjOnly = ensureLateImport(ctx, "__new_plain_object", [], [{ kind: "externref" }]);
    flushLateImportShifts(ctx, fctx);
    if (newObjOnly === undefined) return false;
    // Drop the incoming struct ref (materialize consumes it) and push a fresh obj.
    fctx.body.push({ op: "drop" });
    fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__new_plain_object") ?? newObjOnly });
    return true;
  }

  const newObjIdx = ensureLateImport(ctx, "__new_plain_object", [], [{ kind: "externref" }]);
  const setIdx = ensureLateImport(
    ctx,
    "__extern_set",
    [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
    [],
  );
  flushLateImportShifts(ctx, fctx);
  if (newObjIdx === undefined || setIdx === undefined) return false;
  const finalNew = ctx.funcMap.get("__new_plain_object") ?? newObjIdx;
  const finalSet = ctx.funcMap.get("__extern_set") ?? setIdx;

  // Stash the incoming struct ref so each field read can re-fetch it.
  const structLocal = allocLocal(fctx, `__matstruct_${fctx.locals.length}`, {
    kind: "ref_null",
    typeIdx: structTypeIdx,
  });
  fctx.body.push({ op: "local.set", index: structLocal });

  // obj = __new_plain_object()
  const objLocal = allocLocal(fctx, `__matobj_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "call", funcIdx: finalNew });
  fctx.body.push({ op: "local.set", index: objLocal });

  for (const { f: field, i: fieldIdx } of fields) {
    // Read the field value: struct.get, then coerce to externref so __extern_set
    // can store it. A method field (eqref/ref closure) coerces via the engine's
    // ref→externref arm (extern.convert_any) — the same closure value the
    // as-any-literal path stores, so __to_primitive's method-dispatch finds it.
    fctx.body.push({ op: "local.get", index: structLocal });
    fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx });
    if (field.type.kind !== "externref") {
      coerceType(ctx, fctx, field.type, { kind: "externref" });
    }
    const valLocal = allocLocal(fctx, `__matval_${fctx.locals.length}`, { kind: "externref" });
    fctx.body.push({ op: "local.set", index: valLocal });
    // __extern_set(obj, "<field>", value)
    fctx.body.push({ op: "local.get", index: objLocal });
    addStringConstantGlobal(ctx, field.name);
    fctx.body.push(...stringConstantExternrefInstrs(ctx, field.name));
    fctx.body.push({ op: "local.get", index: valLocal });
    fctx.body.push({ op: "call", funcIdx: finalSet });
  }

  fctx.body.push({ op: "local.get", index: objLocal });
  return true;
}

registerMaterializeStructAsObject(materializeStructAsDynamicObject);

/**
 * (#1239) Compile an object literal whose property list contains at least
 * one `GetAccessorDeclaration` / `SetAccessorDeclaration`.
 *
 * Routes through the JS host's plain-object machinery
 * (`__new_plain_object` + `__extern_set` + `__defineProperty_accessor`)
 * instead of the wasmGC struct path, so V8 sees real accessor descriptors
 * and `Get(o, key)` / `Set(o, key, v)` traps invoke the user-defined
 * getter/setter bodies. Tags the receiving variable in
 * `ctx.externrefAccessorVars` so subsequent `resolveStructNameForExpr`
 * lookups bail out to the externref path everywhere.
 *
 * The wasmGC struct fallback (the pre-fix behavior) emitted a typed field
 * for each accessor key and silently dropped the body — a `Get(o, "x")`
 * via the externref bridge then read the field's default value (`0` /
 * `null` / `undefined`) instead of running the getter.
 */
function compileObjectLiteralWithAccessors(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.ObjectLiteralExpression,
): ValType | null {
  // 1. Tag the receiving variable BEFORE recursing into initializers — so
  //    nested literals (e.g. spread sources) don't see a stale tag.
  let parent: ts.Node | undefined = expr.parent;
  while (parent && (ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent))) {
    parent = parent.parent;
  }
  if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    ctx.externrefAccessorVars.add(parent.name.text);
  }

  // 2. Create the plain JS host object.
  const newObjIdx = ensureLateImport(ctx, "__new_plain_object", [], [{ kind: "externref" }]);
  flushLateImportShifts(ctx, fctx);
  if (newObjIdx === undefined) return null;
  fctx.body.push({ op: "call", funcIdx: newObjIdx });
  const objLocal = allocLocal(fctx, `__objlit_acc_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: objLocal });

  // Pre-pass: pair `get x()` and `set x(v)` declarations on the same name
  // into a single `__defineProperty_accessor` call so the runtime descriptor
  // carries both slots.
  type AccessorPair = {
    getter?: ts.GetAccessorDeclaration;
    setter?: ts.SetAccessorDeclaration;
    firstIdx: number; // emit position (source order of the FIRST occurrence)
    name: string;
  };
  const accessorPairs = new Map<string, AccessorPair>();
  for (let i = 0; i < expr.properties.length; i++) {
    const p = expr.properties[i]!;
    if (!ts.isGetAccessorDeclaration(p) && !ts.isSetAccessorDeclaration(p)) continue;
    const propName = resolveAccessorPropName(ctx, p.name); // (#820b) handles ComputedPropertyName
    if (propName === undefined) continue; // arbitrary computed key: out of scope
    let pair = accessorPairs.get(propName);
    if (!pair) {
      pair = { firstIdx: i, name: propName };
      accessorPairs.set(propName, pair);
    }
    if (ts.isGetAccessorDeclaration(p)) pair.getter = p;
    else pair.setter = p;
  }

  // (#2128) Pre-compute, across ALL accessors in this literal, which outer
  // locals any accessor body writes. Each such local is captured through ONE
  // shared ref cell by every accessor in the literal, so a getter observes
  // its paired setter's writes. The map is per-literal: each evaluation of
  // the literal re-runs the creation sequence and re-fills the cell local.
  const accessorForceMutable = new Set<string>();
  for (const pair of accessorPairs.values()) {
    for (const accFn of [pair.getter, pair.setter]) {
      if (!accFn) continue;
      for (const n of collectMutatedCaptureNames(fctx, accFn as unknown as ts.FunctionExpression)) {
        accessorForceMutable.add(n);
      }
    }
  }
  // (#3051 Slice 3) Also capture-by-reference any local an accessor READS that
  // the ENCLOSING function writes anywhere: `var v; const o = { get x() {
  // return v; } }; v = 1;` must observe the later outer write. Without the
  // shared ref cell, the getter snapshots the creation-time value (undefined) —
  // the exact shape of test262 @@split str-coerce-lastindex-err's
  // `badLastIndex` reassignments between protocol calls. #2128 only forced
  // cells for locals the accessors themselves WRITE; this adds the
  // outer-write/inner-read direction. Ref cells are semantically transparent,
  // so the conservative superset is safe.
  {
    const accessorCaptured = new Set<string>();
    for (const pair of accessorPairs.values()) {
      for (const accFn of [pair.getter, pair.setter]) {
        if (!accFn) continue;
        const fnNode = accFn as unknown as ts.FunctionExpression;
        const own = new Set<string>();
        addFunctionOwnLocals(fnNode, own);
        const refd = new Set<string>();
        const b = fnNode.body;
        if (b !== undefined) {
          if (ts.isBlock(b)) {
            for (const s of b.statements) collectReferencedIdentifiers(s, refd, own);
          } else {
            collectReferencedIdentifiers(b, refd, own);
          }
        }
        for (const n of refd) {
          if (fctx.localMap.has(n)) accessorCaptured.add(n);
        }
      }
    }
    if (accessorCaptured.size > 0) {
      let encl: ts.Node | undefined = expr.parent;
      while (
        encl !== undefined &&
        !ts.isFunctionDeclaration(encl) &&
        !ts.isFunctionExpression(encl) &&
        !ts.isArrowFunction(encl) &&
        !ts.isMethodDeclaration(encl) &&
        !ts.isSourceFile(encl)
      ) {
        encl = encl.parent;
      }
      const enclBody =
        encl !== undefined && !ts.isSourceFile(encl) ? (encl as ts.FunctionLikeDeclaration).body : undefined;
      if (enclBody !== undefined) {
        const writtenOuter = new Set<string>();
        if (ts.isBlock(enclBody)) {
          for (const s of enclBody.statements) collectWrittenIdentifiers(s, writtenOuter);
        } else {
          collectWrittenIdentifiers(enclBody, writtenOuter);
        }
        for (const n of accessorCaptured) {
          if (writtenOuter.has(n)) accessorForceMutable.add(n);
        }
      }
    }
  }
  const accessorSharedRefCells: SharedRefCellMap = new Map();

  // Helper to emit __extern_set(obj, key, value) — both the value and the
  // string key sit on the wasm stack first.
  const setIdx = ensureLateImport(
    ctx,
    "__extern_set",
    [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
    [],
  );
  const accIdx = ensureLateImport(
    ctx,
    "__defineProperty_accessor",
    [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }, { kind: "externref" }, { kind: "f64" }],
    [{ kind: "externref" }],
  );
  flushLateImportShifts(ctx, fctx);
  if (setIdx === undefined || accIdx === undefined) return null;

  // 3. Walk properties in source order. Value/method properties → __extern_set.
  //    Accessor declarations → emit __defineProperty_accessor at the FIRST
  //    occurrence of each name (using the merged getter/setter pair).
  const emittedAccessors = new Set<string>();
  for (let i = 0; i < expr.properties.length; i++) {
    const prop = expr.properties[i]!;
    if (ts.isSpreadAssignment(prop)) {
      // Compile spread source and call __object_assign(target, [source])
      const srcType = compileExpression(ctx, fctx, prop.expression);
      if (srcType) {
        // (#3222 C1) In standalone/WASI, a spread source whose STATIC type is a
        // closed-shape struct (`{...typedObj}`) would otherwise be reinterpreted
        // as an externref via `coerceType` and handed to `__object_assign`, whose
        // native enumeration walks only the open-`$Object` hash — so it copies
        // NOTHING (the struct fields are invisible to `__object_keys`). Instead
        // materialize the struct into a real open `$Object` first (own-enumerable
        // fields only) so `__object_assign` enumerates and copies them correctly.
        //
        // (#4466) The `native-first` gate is load-bearing, not a leftover. The
        // host lane reads closed structs through host reflection already, so it
        // needs no materialization — and materializing there CHANGES OBSERVABLE
        // SPEC BEHAVIOUR: the eager field walk snapshots the source before
        // `__object_assign` runs, so a getter that mutates the outer object
        // mid-spread no longer sees the spec's CopyDataProperties ordering
        // (`language/expressions/{array,new,super}/spread-obj-manipulate-outter-
        // obj-in-getter.js` all flip pass→fail). Dropping the gate to reach a
        // dogfood case in the host lane is not a safe trade.
        const spreadStructIdx =
          ctx.targetProfile.semanticProviders === "native-first" &&
          (srcType.kind === "ref" || srcType.kind === "ref_null") &&
          typeof (srcType as { typeIdx?: number }).typeIdx === "number" &&
          ctx.typeIdxToStructName.has((srcType as { typeIdx: number }).typeIdx)
            ? (srcType as { typeIdx: number }).typeIdx
            : undefined;
        if (
          spreadStructIdx !== undefined &&
          materializeStructAsDynamicObject(ctx, fctx, spreadStructIdx, { skipInternalFields: true })
        ) {
          // $Object now on the stack (externref) — fall through to the existing
          // __object_assign(target, [$Object]) merge.
        } else if (srcType.kind !== "externref") {
          coerceType(ctx, fctx, srcType, { kind: "externref" });
        }
        let arrNewIdx: number | undefined;
        let arrPushIdx: number | undefined;
        if (ctx.targetProfile.semanticProviders === "native-first") {
          const b = ensureObjVecBuilders(ctx);
          arrNewIdx = b.newIdx;
          arrPushIdx = b.pushIdx;
        } else {
          arrNewIdx = ensureLateImport(ctx, "__js_array_new", [], [{ kind: "externref" }]);
          arrPushIdx = ensureLateImport(ctx, "__js_array_push", [{ kind: "externref" }, { kind: "externref" }], []);
        }
        const assignIdx = ensureLateImport(
          ctx,
          "__object_assign",
          [{ kind: "externref" }, { kind: "externref" }],
          [{ kind: "externref" }],
        );
        flushLateImportShifts(ctx, fctx);
        if (arrNewIdx !== undefined && arrPushIdx !== undefined && assignIdx !== undefined) {
          const srcLocal = allocLocal(fctx, `__spread_src_${fctx.locals.length}`, { kind: "externref" });
          fctx.body.push({ op: "local.set", index: srcLocal });
          fctx.body.push({ op: "call", funcIdx: arrNewIdx });
          const arrLocal = allocLocal(fctx, `__spread_arr_${fctx.locals.length}`, { kind: "externref" });
          fctx.body.push({ op: "local.set", index: arrLocal });
          fctx.body.push({ op: "local.get", index: arrLocal });
          fctx.body.push({ op: "local.get", index: srcLocal });
          fctx.body.push({ op: "call", funcIdx: arrPushIdx });
          fctx.body.push({ op: "local.get", index: objLocal });
          fctx.body.push({ op: "local.get", index: arrLocal });
          fctx.body.push({ op: "call", funcIdx: assignIdx });
          fctx.body.push({ op: "local.set", index: objLocal });
        }
      }
    } else if (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop)) {
      // __extern_set(obj, key, value)
      let propName: string | undefined;
      let wellKnownSymId: number | undefined;
      if (ts.isIdentifier(prop.name)) propName = prop.name.text;
      else if (ts.isStringLiteral(prop.name)) propName = prop.name.text;
      else if (ts.isNumericLiteral(prop.name)) propName = prop.name.text;
      else if (ts.isComputedPropertyName(prop.name)) {
        // (#1695) Symmetric with the MethodDeclaration path below: well-known
        // `[Symbol.X]: …` keys must be boxed into real JS Symbols via
        // __box_symbol so host APIs (DisposableStack, `using`, iteration
        // protocols) find the value under the real Symbol property.
        const inner = prop.name.expression;
        if (
          ts.isPropertyAccessExpression(inner) &&
          ts.isIdentifier(inner.expression) &&
          inner.expression.text === "Symbol"
        ) {
          wellKnownSymId = getWellKnownSymbolId(inner.name.text);
        }
        if (wellKnownSymId === undefined) {
          propName = resolveComputedKeyExpression(ctx, prop.name.expression);
        }
      }
      if (wellKnownSymId !== undefined) {
        const boxSymIdx = ensureLateImport(ctx, "__box_symbol", [{ kind: "i32" }], [{ kind: "externref" }]);
        flushLateImportShifts(ctx, fctx);
        if (boxSymIdx === undefined) continue;
        fctx.body.push({ op: "local.get", index: objLocal });
        fctx.body.push({ op: "i32.const", value: wellKnownSymId });
        fctx.body.push({ op: "call", funcIdx: boxSymIdx });
      } else if (propName === undefined && ts.isComputedPropertyName(prop.name)) {
        // (#2126) Runtime computed key: evaluate the key expression here (in
        // source order, before the value — its side effects must run) and
        // pass it to __extern_set as the externref key. The host coerces a
        // non-string key (e.g. a boxed number) per ToPropertyKey.
        fctx.body.push({ op: "local.get", index: objLocal });
        // (#1336) Pass the `externref` expected-type hint so an ESSymbol-typed
        // key (a user `Symbol()`, lowered to a bare i32 id) is boxed into a REAL
        // JS Symbol via `__box_symbol` — matching the element-READ path
        // (property-access.ts → compileExpression(..., {kind:"externref"}),
        // expressions.ts:753 ESSymbolLike arm). Without the hint the manual
        // `coerceType(i32→externref)` below boxed the id as a NUMBER
        // (`__box_number`), so `{ [k]: v }` landed under string key "<id>" and
        // symbol identity was lost (getOwnPropertySymbols empty; `o[k]`,
        // Object.assign, spread all missed it). A non-symbol runtime key
        // (number/string) is unaffected — the hint boxes those exactly as before.
        const keyType = compileExpression(ctx, fctx, prop.name.expression, { kind: "externref" });
        if (!keyType) {
          fctx.body.push({ op: "ref.null.extern" });
        } else if (keyType.kind !== "externref") {
          coerceType(ctx, fctx, keyType, { kind: "externref" });
        }
      } else {
        if (propName === undefined) continue;
        // (#51) Materialize the data-property key via the dual-mode helper, not a
        // bare `global.get <stringGlobalMap.get(propName)>`. Under
        // standalone/nativeStrings `addStringConstantGlobal` records the `-1`
        // sentinel (there is no host string-constant global), so a bare
        // `global.get -1` reaches binary emit as "global index out of range — -1".
        // `stringConstantExternrefInstrs` emits the NativeString inline (externref)
        // path under standalone and the host `global.get` only when a real import
        // global exists — exactly the fix already applied to the accessor-key path
        // below (#1888 S5c).
        addStringConstantGlobal(ctx, propName);
        fctx.body.push({ op: "local.get", index: objLocal });
        for (const instr of stringConstantExternrefInstrs(ctx, propName)) {
          fctx.body.push(instr);
        }
      }
      // Compile value and coerce to externref.
      let valType: ValType | null;
      if (ts.isShorthandPropertyAssignment(prop)) {
        valType = compileExpression(ctx, fctx, prop.name, { kind: "externref" });
      } else {
        // (#3368) This value is stored in a host/open object. Supplying its
        // actual carrier type up front preserves Symbol values as Symbols;
        // compiling first as a bare i32 and coercing afterward loses the
        // ESSymbol semantic brand and boxes the handle as a Number.
        valType = compileExpression(ctx, fctx, prop.initializer, { kind: "externref" });
      }
      if (!valType) {
        // Push undefined as a fallback so the stack stays balanced.
        fctx.body.push({ op: "ref.null.extern" });
      } else if (valType.kind !== "externref") {
        coerceType(ctx, fctx, valType, { kind: "externref" });
      }
      fctx.body.push({ op: "call", funcIdx: setIdx });
    } else if (ts.isMethodDeclaration(prop)) {
      // Compile method as a callback closure, then __extern_set.
      //
      // (#1433) For computed keys that resolve to well-known Symbols
      // (e.g. `[Symbol.dispose]() {…}`), box the i32 symbol ID into a
      // real JS Symbol via __box_symbol so the host can find the method
      // under the real Symbol property. Otherwise the wasmGC struct path
      // would name the field "@@dispose" and native APIs (DisposableStack,
      // `using` declarations) would never see Symbol.dispose.
      let methodName: string | undefined;
      let wellKnownSymId: number | undefined;
      if (ts.isIdentifier(prop.name)) methodName = prop.name.text;
      else if (ts.isStringLiteral(prop.name)) methodName = prop.name.text;
      else if (ts.isComputedPropertyName(prop.name)) {
        const inner = prop.name.expression;
        if (
          ts.isPropertyAccessExpression(inner) &&
          ts.isIdentifier(inner.expression) &&
          inner.expression.text === "Symbol"
        ) {
          wellKnownSymId = getWellKnownSymbolId(inner.name.text);
        }
        if (wellKnownSymId === undefined) {
          // Fall back to the resolved string key (e.g. "@@dispose").
          methodName = resolveComputedKeyExpression(ctx, prop.name.expression);
        }
      }
      if (wellKnownSymId !== undefined) {
        const boxSymIdx = ensureLateImport(ctx, "__box_symbol", [{ kind: "i32" }], [{ kind: "externref" }]);
        flushLateImportShifts(ctx, fctx);
        if (boxSymIdx === undefined) continue;
        fctx.body.push({ op: "local.get", index: objLocal });
        fctx.body.push({ op: "i32.const", value: wellKnownSymId });
        fctx.body.push({ op: "call", funcIdx: boxSymIdx });
        const ok = emitObjectLiteralMethodFn(ctx, fctx, prop as unknown as ts.FunctionExpression);
        if (!ok) {
          fctx.body.push({ op: "ref.null.extern" });
        }
        fctx.body.push({ op: "call", funcIdx: setIdx });
        continue;
      }
      if (methodName === undefined && ts.isComputedPropertyName(prop.name)) {
        // (#2126) Runtime computed method key — same as the PropertyAssignment
        // branch: evaluate the key expression and pass it as the externref key.
        fctx.body.push({ op: "local.get", index: objLocal });
        // (#1336) Pass the `externref` expected-type hint so an ESSymbol-typed
        // key (a user `Symbol()`, lowered to a bare i32 id) is boxed into a REAL
        // JS Symbol via `__box_symbol` — matching the element-READ path
        // (property-access.ts → compileExpression(..., {kind:"externref"}),
        // expressions.ts:753 ESSymbolLike arm). Without the hint the manual
        // `coerceType(i32→externref)` below boxed the id as a NUMBER
        // (`__box_number`), so `{ [k]: v }` landed under string key "<id>" and
        // symbol identity was lost (getOwnPropertySymbols empty; `o[k]`,
        // Object.assign, spread all missed it). A non-symbol runtime key
        // (number/string) is unaffected — the hint boxes those exactly as before.
        const keyType = compileExpression(ctx, fctx, prop.name.expression, { kind: "externref" });
        if (!keyType) {
          fctx.body.push({ op: "ref.null.extern" });
        } else if (keyType.kind !== "externref") {
          coerceType(ctx, fctx, keyType, { kind: "externref" });
        }
        const okRt = emitObjectLiteralMethodFn(ctx, fctx, prop as unknown as ts.FunctionExpression);
        if (okRt) {
          fctx.body.push({ op: "call", funcIdx: setIdx });
        } else {
          // Callback compilation declined — keep the pre-#2126 "property
          // skipped" semantics (drop key + obj) but the key expression's
          // side effects above have already run, per spec evaluation order.
          fctx.body.push({ op: "drop" });
          fctx.body.push({ op: "drop" });
        }
        continue;
      }
      if (methodName === undefined) continue;
      // (#2194) Same dual-mode key fix as the data-property arm above: the raw
      // `global.get <stringGlobalMap.get(method)>` baked `global.get -1` in
      // standalone for a method key on a literal that also takes the accessor
      // path. Route through the guarded helper.
      addStringConstantGlobal(ctx, methodName);
      fctx.body.push({ op: "local.get", index: objLocal });
      for (const instr of stringConstantExternrefInstrs(ctx, methodName)) {
        fctx.body.push(instr);
      }
      const ok = emitObjectLiteralMethodFn(ctx, fctx, prop as unknown as ts.FunctionExpression);
      if (!ok) {
        fctx.body.push({ op: "ref.null.extern" });
      }
      fctx.body.push({ op: "call", funcIdx: setIdx });
    } else if (ts.isGetAccessorDeclaration(prop) || ts.isSetAccessorDeclaration(prop)) {
      // Emit one __defineProperty_accessor call per pair, at the position
      // of the FIRST get/set declaration on this name. Subsequent siblings
      // for the same name are skipped (their info was merged into the pair
      // during the pre-pass).
      const propName = resolveAccessorPropName(ctx, prop.name); // (#820b)
      if (propName === undefined) continue;
      const pair = accessorPairs.get(propName);
      if (!pair) continue;
      if (emittedAccessors.has(propName)) continue;
      if (pair.firstIdx !== i) continue; // wait for the actual first slot
      emittedAccessors.add(propName);

      // Stack: [obj, key, getterCb | null, setterCb | null, flags]
      fctx.body.push({ op: "local.get", index: objLocal });
      // (#1888 S5c / C5) Materialize the accessor key via the dual-mode helper.
      // Under standalone/nativeStrings, `addStringConstantGlobal` records the
      // `-1` sentinel (no host string-constant global), so the old
      // `global.get <stringGlobalMap.get(prop)>` emitted `global.get -1` →
      // "u32 out of range: -1" at serialize time (the objlit-accessor standalone
      // defect). `stringConstantExternrefInstrs` emits the native-string inline
      // path under standalone and the host `global.get` under GC.
      addStringConstantGlobal(ctx, propName);
      for (const instr of stringConstantExternrefInstrs(ctx, propName)) {
        fctx.body.push(instr);
      }

      // Getter (or ref.null.extern when only setter is defined).
      // (#1888 S5b) Under standalone, compile as a HOST-FREE closure so the
      // stored $PropEntry.$get holds a real callable closure that __extern_get's
      // accessor arm dispatches via __call_accessor_get → __call_fn_method_0
      // (receiver bound as `this` through __current_this). Else JS-host callback.
      if (pair.getter) {
        const ok = emitObjectLiteralAccessorFn(ctx, fctx, pair.getter as unknown as ts.FunctionExpression, {
          forceMutableCaptures: accessorForceMutable,
          sharedRefCells: accessorSharedRefCells,
        });
        if (!ok) fctx.body.push({ op: "ref.null.extern" });
      } else {
        fctx.body.push({ op: "ref.null.extern" });
      }

      // Setter
      if (pair.setter) {
        const ok = emitObjectLiteralAccessorFn(ctx, fctx, pair.setter as unknown as ts.FunctionExpression, {
          forceMutableCaptures: accessorForceMutable,
          sharedRefCells: accessorSharedRefCells,
        });
        if (!ok) fctx.body.push({ op: "ref.null.extern" });
      } else {
        fctx.body.push({ op: "ref.null.extern" });
      }

      // Flags: enumerable=true, configurable=true (writable is N/A for
      // accessor descriptors; matches `computeRuntimeFlags(undefined,
      // true, true, false)` from object-ops.ts).
      // Bits: enumerable_specified (1<<4) | enumerable_value (1<<1)
      //     | configurable_specified (1<<5) | configurable_value (1<<2)
      const flags = (1 << 4) | (1 << 1) | (1 << 5) | (1 << 2);
      fctx.body.push({ op: "f64.const", value: flags });

      fctx.body.push({ op: "call", funcIdx: accIdx });
      fctx.body.push({ op: "drop" }); // returns the same externref
    }
  }

  fctx.body.push({ op: "local.get", index: objLocal });
  return { kind: "externref" };
}

/**
 * (#1888 S5b) Compile an object-literal accessor getter/setter and leave an
 * externref on the stack for `__defineProperty_accessor`. Standalone →
 * host-free closure (`compileArrowAsClosure`, converted to externref); JS-host /
 * GC → `compileArrowAsCallback` with `needsThis: true` (unchanged
 * `__make_getter_callback` bridge). Returns `false` when the caller should push
 * `ref.null.extern`. Mirrors `emitAccessorFn` in object-ops.ts.
 */
function emitObjectLiteralAccessorFn(
  ctx: CodegenContext,
  fctx: FunctionContext,
  fn: ts.FunctionExpression | ts.ArrowFunction,
  // (#2128) per-literal shared-cell capture options — see compileArrowAsCallback
  captureOptions?: { forceMutableCaptures?: Set<string>; sharedRefCells?: SharedRefCellMap },
): boolean {
  if (ctx.standalone || ctx.targetProfile.semanticProviders === "native-first") {
    const closureType = compileArrowAsClosure(ctx, fctx, fn);
    if (!closureType) return false;
    if (closureType.kind !== "externref") {
      fctx.body.push({ op: "extern.convert_any" });
    }
    return true;
  }
  return !!compileArrowAsCallback(ctx, fctx, fn, { needsThis: true, ...captureOptions });
}

/**
 * (#2194 follow-up) Compile an object-literal METHOD body and leave a callable
 * externref on the stack for `__extern_set`. Mirrors the getter/setter routing
 * in `emitObjectLiteralAccessorFn`: standalone → host-free closure
 * (`compileArrowAsClosure`, converted to externref) so the method does NOT leak
 * the `__make_getter_callback` JS bridge; JS-host / GC → `compileArrowAsCallback`
 * with `needsThis: true` (unchanged host bridge). Returns `false` when the caller
 * should push `ref.null.extern`.
 *
 * Why: the three MethodDeclaration arms below previously called
 * `compileArrowAsCallback(... { needsThis: true })` unconditionally, which routes
 * through `__make_getter_callback` (an `env::` host import, closures.ts) even in
 * `--target standalone`. The sibling get/set arm was already standalone-aware
 * (#1888 S5b); a literal mixing a regular method with a getter therefore left the
 * getter host-free but leaked the bridge for the method. The standalone method
 * closure is invoked through the same `__current_this`-bound closure-call path the
 * getter closures use, so `this` is bound correctly.
 */
function emitObjectLiteralMethodFn(ctx: CodegenContext, fctx: FunctionContext, fn: ts.FunctionExpression): boolean {
  if (ctx.standalone || ctx.targetProfile.semanticProviders === "native-first") {
    const closureType = compileArrowAsClosure(ctx, fctx, fn);
    if (!closureType) return false;
    if (closureType.kind !== "externref") {
      fctx.body.push({ op: "extern.convert_any" });
    }
    return true;
  }
  return !!compileArrowAsCallback(ctx, fctx, fn, { needsThis: true });
}

/**
 * (#2127) True when the literal contains a spread whose SOURCE type carries
 * accessor-declared own properties (get/set). The struct spread lowering
 * copies data fields by struct layout and never invokes getters — per spec
 * CopyDataProperties each own enumerable key gets a [[Get]] whose result is
 * copied as a data property. Such literals must take the host plain-object
 * path, whose spread uses __object_assign (Object.assign semantics = the
 * required [[Get]]-then-copy).
 */
function _hasAccessorSpreadSource(ctx: CodegenContext, expr: ts.ObjectLiteralExpression): boolean {
  for (const p of expr.properties) {
    if (!ts.isSpreadAssignment(p)) continue;
    let srcType: ts.Type | undefined;
    try {
      srcType = ctx.checker.getTypeAtLocation(p.expression);
    } catch {
      continue;
    }
    if (!srcType) continue;
    for (const sym of srcType.getProperties()) {
      if ((sym.flags & (ts.SymbolFlags.GetAccessor | ts.SymbolFlags.SetAccessor)) !== 0) return true;
      const decls = sym.declarations ?? [];
      if (decls.some((d) => ts.isGetAccessorDeclaration(d) || ts.isSetAccessorDeclaration(d))) return true;
    }
  }
  return false;
}

/**
 * (#1433) Check whether an object literal contains a method whose computed
 * property name resolves to `Symbol.dispose` or `Symbol.asyncDispose`. Such
 * objects MUST be routed through the JS-host plain-object path so the
 * native runtime (e.g. `using r = res` / `DisposableStack.use(res)`) can
 * find a real Symbol.dispose property on the resource. The WasmGC struct
 * path would store these under field name "@@dispose", which the host
 * never sees as a Symbol property.
 */
function _hasDisposalMethod(expr: ts.ObjectLiteralExpression): boolean {
  for (const p of expr.properties) {
    // (#1695) Catch both MethodDeclaration (`[Symbol.dispose]() {}`) and
    // PropertyAssignment (`[Symbol.dispose]: () => {}`) shapes — both must
    // route to the externref/accessor path so the host sees a real Symbol
    // key on the resulting object.
    if (!ts.isMethodDeclaration(p) && !ts.isPropertyAssignment(p)) continue;
    if (!ts.isComputedPropertyName(p.name)) continue;
    const inner = p.name.expression;
    if (!ts.isPropertyAccessExpression(inner)) continue;
    if (!ts.isIdentifier(inner.expression) || inner.expression.text !== "Symbol") continue;
    const propName = inner.name.text;
    if (propName === "dispose" || propName === "asyncDispose") return true;
  }
  return false;
}

/**
 * (#2126) True when the literal has a data property or method whose computed
 * key is only known at runtime — `[expr]` neither folds to a compile-time
 * string (resolveComputedKeyExpression) nor names a well-known `Symbol.X`
 * (those keep their existing __box_symbol routing). The struct paths lay out
 * fields from compile-time names only, so these literals must take the host
 * plain-object path, which evaluates the key expression at runtime.
 */
export function _hasRuntimeComputedKey(ctx: CodegenContext, expr: ts.ObjectLiteralExpression): boolean {
  for (const p of expr.properties) {
    if (!ts.isPropertyAssignment(p) && !ts.isMethodDeclaration(p)) continue;
    if (!ts.isComputedPropertyName(p.name)) continue;
    const inner = p.name.expression;
    if (
      ts.isPropertyAccessExpression(inner) &&
      ts.isIdentifier(inner.expression) &&
      inner.expression.text === "Symbol" &&
      getWellKnownSymbolId(inner.name.text) !== undefined
    ) {
      continue;
    }
    if (resolveComputedKeyExpression(ctx, inner) === undefined) return true;
  }
  return false;
}

function isModuleGlobalHostSpreadIdentifier(ctx: CodegenContext, expression: ts.Expression): boolean {
  if (!ts.isIdentifier(expression)) return false;
  return ctx.hostSpreadObjectGlobals.has(expression.text);
}

function isModuleGlobalObjectLiteral(expr: ts.ObjectLiteralExpression): boolean {
  const declaration = expr.parent;
  if (!declaration || !ts.isVariableDeclaration(declaration) || declaration.initializer !== expr) return false;
  const list = declaration.parent;
  const statement = list.parent;
  return ts.isVariableDeclarationList(list) && ts.isVariableStatement(statement) && ts.isSourceFile(statement.parent);
}

/**
 * Read a host/open object into a closed struct when it is used as a field of
 * another closed literal.  This keeps the containing value on the fast static
 * field path without forcing the entire module-level object graph onto the
 * dynamic host dispatcher.  The source remains an open object for callers
 * that need its runtime key set; only this typed field receives a snapshot of
 * the fields its consumer declares.
 */
function compileHostObjectAsStruct(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expression: ts.Expression,
  target: ValType,
): ValType | null {
  if (target.kind !== "ref" && target.kind !== "ref_null") return null;
  const typeIdx = target.typeIdx;
  const typeName = ctx.typeIdxToStructName.get(typeIdx);
  const fields = typeName === undefined ? undefined : ctx.structFields.get(typeName);
  if (!fields || fields.length === 0) return null;
  const getIdx = ensureLateImport(
    ctx,
    "__extern_get",
    [{ kind: "externref" }, { kind: "externref" }],
    [{ kind: "externref" }],
  );
  if (getIdx === undefined) return null;
  flushLateImportShifts(ctx, fctx);
  const finalGetIdx = ctx.funcMap.get("__extern_get") ?? getIdx;
  const sourceLocal = allocTempLocal(fctx, { kind: "externref" });
  const sourceType = compileExpression(ctx, fctx, expression, { kind: "externref" });
  if (!sourceType) return null;
  fctx.body.push({ op: "local.set", index: sourceLocal });
  for (const field of fields) {
    fctx.body.push({ op: "local.get", index: sourceLocal });
    addStringConstantGlobal(ctx, field.name);
    fctx.body.push(...stringConstantExternrefInstrs(ctx, field.name));
    fctx.body.push({ op: "call", funcIdx: finalGetIdx });
    coerceType(ctx, fctx, { kind: "externref" }, field.type);
  }
  fctx.body.push({ op: "struct.new", typeIdx });
  releaseTempLocal(fctx, sourceLocal);
  return { kind: "ref", typeIdx };
}

/**
 * (#4616) The accessor/computed-key/disposal/empty-key HOST-PATH gate,
 * extracted so the variable-declaration LOCAL TYPING (statements/variables.ts)
 * can make the IDENTICAL decision — the #2804 lockstep discipline. Before
 * this, a literal with a computed SYMBOL key (`{ a: 1, [symbolKey]: 3 }`)
 * built a host plain object here while the un-annotated local stayed
 * struct-typed, so the store null-cast and the value read back as NULL in
 * the lifted-closure lanes (jest Replaceable "Type null is not support").
 */
/**
 * (#4638) A DATA-ONLY object literal one of whose property values is the realm
 * GLOBAL OBJECT — script top-level `this`, or `globalThis`.
 *
 * The global object has no compiled WasmGC struct representation (#4394): it is
 * a host externref in the JS-host lane and the native `$Object` singleton under
 * standalone. But the checker types it as the enormous structural
 * `typeof globalThis`, so a literal that holds it gets a struct FIELD typed
 * `(ref null $__anon_globalThis)`. Storing the value into that field emits the
 * guarded `ref.test` / `ref.null` coercion, which can never match — so the field
 * silently becomes NULL. Two things then go wrong, and the second is worse than
 * the first:
 *
 *   1. the value is lost (`{ configurable: this }` reads back as falsy), and
 *   2. any consumer that materializes the struct for the dynamic boundary reads
 *      that null field and does `struct.get` on it — an UNCATCHABLE trap.
 *      `Object.defineProperty(o, "p", attr)` with `var attr = { configurable:
 *      this }` reifies the descriptor exactly that way (`15.2.3.6-3-123`).
 *
 * Routing the literal to the open `$Object` builder stores the global object as
 * the externref it actually is, so both go away. This is the nested-property
 * twin of the #3365 rule that already widens `var t = this` to externref.
 *
 * NARROWED to data-only literals (no methods/accessors/spreads, and no
 * function/class/object-literal-valued properties) on purpose: that is the shape
 * where the loss is provable and the `$Object` builder is a faithful
 * replacement. The test262 harness's own `$262 = { global: globalThis, gc:
 * function () {}, … }` is deliberately OUTSIDE the narrowing — re-representing
 * the harness host object is a much larger blast radius than this fix needs.
 */
function _hasRealmGlobalObjectValue(ctx: CodegenContext, expr: ts.ObjectLiteralExpression): boolean {
  const isRealmGlobal = (init: ts.Expression): boolean => {
    let cur: ts.Expression = init;
    while (
      ts.isParenthesizedExpression(cur) ||
      ts.isAsExpression(cur) ||
      ts.isNonNullExpression(cur) ||
      ts.isTypeAssertionExpression(cur)
    ) {
      cur = cur.expression;
    }
    if (ts.isIdentifier(cur)) return cur.text === "globalThis";
    if (cur.kind !== ts.SyntaxKind.ThisKeyword) return false;
    // Script top-level `this` only. An arrow does not rebind `this`, so it does
    // not interrupt the walk; every other function-like scope (and a class body)
    // does.
    if (ctx.sourceIsModule) return false;
    for (let n: ts.Node | undefined = cur.parent; n; n = n.parent) {
      if (ts.isSourceFile(n)) return true;
      if (
        ts.isFunctionDeclaration(n) ||
        ts.isFunctionExpression(n) ||
        ts.isMethodDeclaration(n) ||
        ts.isConstructorDeclaration(n) ||
        ts.isGetAccessorDeclaration(n) ||
        ts.isSetAccessorDeclaration(n) ||
        ts.isClassDeclaration(n) ||
        ts.isClassExpression(n)
      ) {
        return false;
      }
    }
    return false;
  };
  let sawGlobal = false;
  for (const p of expr.properties) {
    if (!ts.isPropertyAssignment(p)) return false; // methods/accessors/spread/shorthand → outside the narrowing
    const init = p.initializer;
    if (
      ts.isFunctionExpression(init) ||
      ts.isArrowFunction(init) ||
      ts.isClassExpression(init) ||
      ts.isObjectLiteralExpression(init)
    ) {
      return false;
    }
    if (isRealmGlobal(init)) sawGlobal = true;
  }
  return sawGlobal;
}

export function objectLiteralForcesHostPath(ctx: CodegenContext, expr: ts.ObjectLiteralExpression): boolean {
  return (
    expr.properties.length > 0 &&
    (expr.properties.some((p) => ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p)) ||
      _hasDisposalMethod(expr) ||
      _hasRuntimeComputedKey(ctx, expr) ||
      // (#4616, cookie parseCookie tests) An EMPTY-STRING key (`{ "": "bar" }`
      // — a legal JS property) cannot be a struct field: the field-name
      // plumbing (`__struct_field_names` comma join, `__sget_<name>` exports)
      // degenerates on "", so the property silently vanished (Object.keys []
      // and even the in-module read answered undefined). The host plain-object
      // path stores it faithfully.
      expr.properties.some(
        (p) =>
          (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && resolvePropertyNameText(ctx, p) === "",
      ) ||
      // (#4638) a data-only literal holding the realm global object — see
      // `_hasRealmGlobalObjectValue`.
      _hasRealmGlobalObjectValue(ctx, expr))
  );
}

export function objectLiteralSpreadTakesHostPath(ctx: CodegenContext, expr: ts.ObjectLiteralExpression): boolean {
  if (expr.properties.length === 0) return false;
  if (!expr.properties.some((p) => ts.isSpreadAssignment(p))) return false;
  let spreadCtxType = ctx.checker.getContextualType(expr);
  // (#4616) An OPTIONAL slot's contextual type is `T | undefined` (jest's
  // `options = { …defaults, ...options }` param reassignment): the union's
  // `getProperties()` is empty, which mis-read a perfectly concrete shape as
  // "non-specific" and routed the literal to the host path — whose result
  // then null-casted back into the struct-typed slot. Strip nullish
  // constituents; a single object part left over is the concrete context.
  if (spreadCtxType?.isUnion()) {
    const parts = spreadCtxType.types.filter((p) => (p.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)) === 0);
    if (parts.length === 1) spreadCtxType = parts[0];
  }
  const nonSpecificContext =
    !spreadCtxType ||
    (spreadCtxType.flags & ts.TypeFlags.Any) !== 0 ||
    (spreadCtxType.flags & ts.TypeFlags.Unknown) !== 0 ||
    (spreadCtxType.flags & ts.TypeFlags.NonPrimitive) !== 0 ||
    spreadCtxType.getProperties().length === 0;
  if (!nonSpecificContext) {
    // A concrete context still owns a closed shape. The nested carrier is only
    // needed for shapeless module globals, just like a direct spread.
    return false;
  }
  return true;
}

/**
 * (#3037 CS1a) True when a **non-empty, spread-free, data-only** object literal
 * is produced into a genuine `any`/`unknown` contextual position under
 * `--target standalone` — a subset of the `isAnyContextNonEmpty` branch of
 * `compileObjectLiteral` that builds it as an open `$Object` and hands back an
 * **externref**. This is the object-identity CS1a "carrier" site: such a literal
 * assigned to an `any`-typed local is currently carried as an externref, so at
 * `===` it boxes **tag-5** and loses `ref.eq` identity (an object is not `===`
 * to itself). The variable-declaration local typing (statements/variables.ts)
 * consults this predicate to slot the local as a raw `ref $Object` instead — so
 * the value boxes **tag-6** (`__any_box_ref`, identity in `refval`) at `===`
 * (the tag-6 same-tag `ref.eq` arm answers identity) while dynamic `any`-typed
 * reads coerce the ref back to externref (`extern.convert_any`) for
 * `__extern_get`. This keeps the local representation and the literal's value in
 * lockstep, the same discipline `objectLiteralSpreadTakesHostPath` enforces.
 *
 * Scoped tightly to keep the beachhead low-risk and to avoid colliding with the
 * earlier `compileObjectLiteral` gates: **no spreads** (those route via
 * `objectLiteralSpreadTakesHostPath` → host path), **no accessors/methods/
 * computed keys** (all-data-property + resolvable-name check), non-empty, not a
 * parameter default. The pure string-index DICTIONARY case is intentionally
 * excluded (it must keep the externref carrier for runtime `o[k]=v` writes).
 */
export function objectLiteralIsStandaloneAnyObjectCarrier(
  ctx: CodegenContext,
  expr: ts.ObjectLiteralExpression,
): boolean {
  if (!ctx.standalone) return false;
  if (expr.properties.length === 0) return false;
  if (ts.isParameter(expr.parent)) return false;
  // Data-only, spread-free, statically-named keys — matches the open-`$Object`
  // any-context branch of `compileObjectLiteral` (minus spreads / dictionaries).
  if (!expr.properties.every((p) => ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p))) {
    return false;
  }
  if (!expr.properties.every((p) => resolvePropertyNameText(ctx, p) !== undefined)) return false;
  // (#1930) Query the contextual type through the oracle boundary, not the raw
  // TypeChecker. `contextualFactOf` classifies `any`/`unknown` directly; the
  // `object` keyword (NonPrimitive) is not a distinct fact — it is intentionally
  // NOT covered here (an `object`-keyword-typed carrier is a rare, safe
  // under-fix: the literal stays externref/tag-5, reconciled by S3a). The `any`
  // case is the CS1a beachhead.
  const ctxFact = ctx.oracle.contextualFactOf(expr);
  return ctxFact !== undefined && (ctxFact.kind === "any" || ctxFact.kind === "unknown");
}

/**
 * (#1901/#2542, extracted for #3128) The standalone open-`$Object` divert
 * decision for a NON-EMPTY object literal: `compileObjectLiteral` builds the
 * literal as an open `$Object` handed back as **externref** (via
 * `compileObjectLiteralAsExternref`) instead of a closed struct when this
 * predicate answers true. Exported so CONSUMERS that pre-decide a slot type
 * for the literal's value can make the IDENTICAL decision — the same
 * lockstep discipline `objectLiteralSpreadTakesHostPath` (#2804) and
 * `objectLiteralIsStandaloneAnyObjectCarrier` (#1930) established. The
 * inlined-IIFE return-local typing (calls.ts, #3128) consults this: typing
 * the ret-local from the TS struct type while the literal lowers dynamically
 * made the ret-value coercion's `ref.test` arm silently null the result.
 *
 * Shape gate: standalone only; data props / spreads / plain-named method
 * shorthand (#3099), no accessor / computed / symbol keys, not a parameter
 * default. Context gate: requires an EXPLICIT any / unknown / `object`
 * contextual type (#1897 — an ABSENT contextual type means consumers compile
 * against the inferred struct), or a PURE string-index dictionary context
 * (#2542).
 */
export function objectLiteralTakesStandaloneAnyObjectPath(
  ctx: CodegenContext,
  expr: ts.ObjectLiteralExpression,
): boolean {
  if (
    // (#2542) `ctx.wasi` admitted so the PURE string-index arm below can fire on
    // the other host-free target; the #1901 any-context arm stays standalone-only,
    // enforced at the return.
    !(ctx.standalone || ctx.wasi) ||
    expr.properties.length === 0 ||
    ts.isParameter(expr.parent) ||
    // only data props / spreads / plain-named method shorthand we can build onto
    // a $Object (no accessor / computed-key / mixed shapes that need the struct or
    // host accessor path). (#3099) Plain-named method shorthand is now buildable
    // here — compileObjectLiteralAsExternref materializes it as a runtime own
    // property closure — so a method-bearing any-context literal (`const h: any =
    // { m() {…} }`) builds as an open `$Object` whose runtime-keyed reads
    // (`h[k]`, `Object.keys`, for-in) find the method, instead of an anon struct
    // whose method exists only in the compile-time member table.
    !expr.properties.every(
      (p) =>
        ts.isPropertyAssignment(p) ||
        ts.isShorthandPropertyAssignment(p) ||
        ts.isSpreadAssignment(p) ||
        isPlainNamedMethodDeclaration(p),
    ) ||
    // and no computed/symbol keys (resolvePropertyNameText / the plain-method
    // check return undefined/false for those).
    !expr.properties.every(
      (p) =>
        ts.isSpreadAssignment(p) || isPlainNamedMethodDeclaration(p) || resolvePropertyNameText(ctx, p) !== undefined,
    )
  ) {
    return false;
  }
  const ctxTypeNonEmpty = ctx.checker.getContextualType(expr);
  // Require an EXPLICIT any / unknown / `object` contextual type to divert to
  // the open-`$Object` path. An ABSENT contextual type means TypeScript
  // infers a concrete *struct* type for the literal — and every downstream
  // consumer (member reads off the inferred-typed local, destructuring
  // patterns, numeric coercion) compiles against that struct type. Routing
  // such a literal to `$Object` makes the consumers null-deref (struct.get on
  // a `$Object`) or mis-coerce (`(o as any) - 0` → 0 instead of NaN, the
  // #1806/#1900 contract). This bit the -45 standalone gate (#1897): 116
  // regressions across language/expressions/object (parenthesized literals,
  // `var obj = ({var: 42})`) and for-of/for-await-of destructuring sources —
  // all shapes with NO contextual type whose consumers use the struct path.
  // The nested-property-value case (`g({x: {y: 5}})` inner `{y: 5}`, also no
  // contextual type) is handled separately by construction-site recursion in
  // compileObjectLiteralAsExternref, NOT by this gate.
  const isAnyContextNonEmpty =
    !!ctxTypeNonEmpty &&
    ((ctxTypeNonEmpty.flags & ts.TypeFlags.Any) !== 0 ||
      (ctxTypeNonEmpty.flags & ts.TypeFlags.Unknown) !== 0 ||
      (ctxTypeNonEmpty.flags & ts.TypeFlags.NonPrimitive) !== 0);
  // (#2542) A STRING-INDEX-SIGNATURE contextual type — `{ [s: string]: T }` — is
  // semantically an open dictionary: its sole purpose is runtime string-keyed
  // access (`o[k]` with a runtime `k`). `resolveWasmType` already lowers such a
  // type to externref for the binding (no named properties → falls through to
  // `mapTsTypeToWasm` → externref), so the consuming local is externref and ALL
  // reads/writes route through `__extern_get`/`__extern_set`. But the closed-
  // struct literal path builds a nominal `struct.new` and `extern.convert_any`-
  // wraps it; `__extern_get`'s `ref.test $Object` then can't match the struct, so
  // `o[k]` returns 0 and `o[k] = v` is dropped. Building the literal as an open
  // `$Object` (same as #1901's any-context route) makes every native reader find
  // the property. Restricted to a PURE dictionary (no own named properties): a
  // mixed `{ a: number; [s: string]: T }` registers a concrete struct for the
  // binding (the `__type` anon-struct branch fires on `getProperties().length > 0`),
  // so diverting its literal to `$Object` would mismatch that struct local.
  const strIndex = ctxTypeNonEmpty ? ctx.checker.getIndexInfoOfType(ctxTypeNonEmpty, ts.IndexKind.String) : undefined;
  const isPureStringIndexContext = !!strIndex && !!ctxTypeNonEmpty && ctxTypeNonEmpty.getProperties().length === 0;
  // #1901's any-context arm stays standalone-only (widening it would change every
  // any-typed literal's lowering under wasi); #2542's index arm covers both.
  return (ctx.standalone && isAnyContextNonEmpty) || isPureStringIndexContext;
}

/**
 * (#4394) Build an object literal directly as the struct the call boundary
 * EXPECTS, when its own inferred shape is a different struct.
 *
 * Returns the built value's `ValType`, or `undefined` to decline — in which
 * case NOTHING has been emitted and the caller keeps its existing lowering.
 *
 * Declines unless the diversion can only replace a downcast that was going to
 * fail: the expected typeIdx must name a registered struct, every property the
 * literal writes must be one of its fields, and the literal's own struct
 * resolution must be a DIFFERENT type (equal shapes already lower correctly).
 * Spreads, accessors, methods and computed keys decline — those carry their own
 * dedicated lowerings above this point.
 */
function tryCompileObjectLiteralAsExpectedStruct(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.ObjectLiteralExpression,
  expectedTypeIdx: number,
): ValType | null | undefined {
  let expectedName: string | undefined;
  for (const [name, idx] of ctx.structMap) {
    if (idx === expectedTypeIdx) {
      expectedName = name;
      break;
    }
  }
  if (expectedName === undefined) return undefined;
  const expectedFields = ctx.structFields.get(expectedName);
  if (!expectedFields || expectedFields.length === 0) return undefined;

  const fieldNames = new Set(expectedFields.map((field) => field.name));
  for (const prop of expr.properties) {
    if (!ts.isPropertyAssignment(prop) && !ts.isShorthandPropertyAssignment(prop)) return undefined;
    const nameNode = prop.name;
    if (!ts.isIdentifier(nameNode) && !ts.isStringLiteral(nameNode)) return undefined;
    if (!fieldNames.has(nameNode.text)) return undefined;
  }

  // oracle-ratchet-allow (#4394, granted in the issue frontmatter): the same
  // raw-type-IDENTITY question the #3536 arm below asks — `resolveStructName`
  // keys off `ts.Type` identity to reach `anonTypeMap`/`structMap`, a
  // wasm-lowering ValType question the oracle deliberately does not express.
  let litType: ts.Type | undefined;
  try {
    litType = ctx.checker.getTypeAtLocation(expr);
  } catch {
    litType = undefined;
  }
  if (litType === undefined) return undefined;
  const litStructName = resolveStructName(ctx, litType);
  if (litStructName !== undefined && ctx.structMap.get(litStructName) === expectedTypeIdx) {
    // Same shape — the existing path already builds a matching struct.
    return undefined;
  }

  ensureComputedPropertyFields(ctx, fctx, expr, litType);
  return compileObjectLiteralForStruct(ctx, fctx, expr, expectedName);
}

export function compileObjectLiteral(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.ObjectLiteralExpression,
  expectedType?: ValType,
): ValType | null {
  // (#1239) If the literal carries any get/set accessor declarations,
  // route to the JS-host plain-object path so the runtime sees real
  // accessor descriptors. Must run BEFORE any contextual-type / struct
  // resolution so the wasmGC struct path can't intercept.
  //
  // (#1433) Same routing for objects containing a `[Symbol.dispose]` or
  // `[Symbol.asyncDispose]` method — host DisposableStack / `using`
  // declarations rely on real Symbol-keyed properties.
  //
  // (#2126) Same routing for literals with a RUNTIME computed key — `[expr]`
  // that neither folds to a compile-time string nor names a well-known
  // Symbol. The struct paths lay out fields from compile-time-known names
  // only, so such a property (and the key expression's side effects) would
  // be silently dropped; the host plain-object path evaluates the key at
  // runtime.
  if (objectLiteralForcesHostPath(ctx, expr)) {
    return compileObjectLiteralWithAccessors(ctx, fctx, expr);
  }

  // (#2127) Accessor-bearing spreads need host CopyDataProperties [[Get]].
  if (expr.properties.length > 0 && _hasAccessorSpreadSource(ctx, expr)) {
    return compileObjectLiteralWithAccessors(ctx, fctx, expr);
  }
  // (#3633) Foreign eval literals lack checker types and require the open representation.
  if (isForeignEvalNode(expr)) return compileObjectLiteralAsExternref(ctx, fctx, expr);
  // (#2714) A spread-containing literal evaluated in a NON-SPECIFIC contextual
  // type (`any`/`unknown`/`object`, or no contextual type) must take the host
  // plain-object path, like the empty-`{}` any-context arm below. The struct
  // path lays out fields from the literal's STATIC type only, so spread-copied
  // keys (which are dynamic — CopyDataProperties at runtime) are absent from the
  // key list `Object.keys` walks; and an INLINE spread source consumed directly
  // (e.g. `Object.keys({ ...{ a, b } })`, whose contextual type is the `object`
  // param of `Object.keys`) underflows the struct-spread assembly's `struct.new`.
  // When a CONCRETE struct type is expected (e.g. `const x: { a: number } =
  // { ...o }`), keep the struct path so typed consumers still get a struct.
  // (Assigning to an `any`/untyped variable already worked via the host path;
  // this generalizes the same routing to the direct-call-argument position.)
  // (#2804) Routes through the shared `objectLiteralSpreadTakesHostPath`
  // predicate so the variable-declaration local typing (variables.ts / index.ts)
  // can make the IDENTICAL decision and force a matching externref local.
  if (objectLiteralSpreadTakesHostPath(ctx, expr)) {
    return compileObjectLiteralWithAccessors(ctx, fctx, expr);
  }

  // (#802 Slice A) This literal is the RECEIVER of a proto mutation
  // (`Object.setPrototypeOf(o, p)` / `Reflect.setPrototypeOf` / `o.__proto__ =`),
  // as detected by the `scanForDynamicProto` pre-scan. Build it as an open
  // `$Object` instead of a closed-shape struct: `$Object` carries a mutable
  // `$proto` (field 0) and the native setPrototypeOf/read/getPrototypeOf helpers
  // already give it full, correct, standalone dynamic-prototype semantics — so a
  // closed struct (which has no `$proto`, and fails `__object_setPrototypeOf`'s
  // `ref.test $Object` in standalone → silently drops the link) is exactly what
  // must be avoided here. The variable-local typing in statements/variables.ts +
  // index.ts consults the SAME `ctx.dynamicProtoLiteralNodes` set so the slot is
  // externref and stays in lockstep with this value representation. Falls through
  // to the normal path if the `$Object` builder is unavailable (null).
  //
  // STANDALONE-ONLY: the dropped-link gap this fixes is standalone-only (spec §0)
  // — in gc/host a proto receiver is already served by the host runtime's
  // `_wasmStructProto` sidecar + host setPrototypeOf, and the gc/host inherited
  // string-key read path (`__extern_get`) is separate host plumbing outside this
  // slice's scope. Gate promotion to standalone so gc/host stays byte-for-byte
  // unchanged (zero host-regression surface).
  if (ctx.standalone && ctx.dynamicProtoLiteralNodes.has(expr)) {
    const promoted = compileObjectLiteralAsExternref(ctx, fctx, expr);
    if (promoted !== null) return promoted;
  }

  // If this empty object literal is the initializer of a variable with widened
  // properties (from pre-pass), register the struct with those extra fields and
  // compile as a struct.new with default values for the widened fields.
  if (expr.properties.length === 0 && ts.isVariableDeclaration(expr.parent) && ts.isIdentifier(expr.parent.name)) {
    // (#3364) Look up by the DECLARATION-site key, not the bare name.
    const widenedProps = ctx.widenedTypeProperties.get(widenedVarKeyFromDecl(expr.parent.name));
    if (widenedProps && widenedProps.length > 0) {
      return compileWidenedEmptyObject(ctx, fctx, expr, widenedProps);
    }
  }

  // Empty `{}` used as an externref plain object — only when the TypeScript type
  // context is `any`, `unknown`, or `object` (non-primitive), meaning no specific struct
  // shape is expected.
  // Do NOT apply to: parameter defaults where the struct system expects a concrete
  // typed object for destructuring.
  // Binding element defaults (e.g. `for ([a = {}] of ...)`) are safe to handle here:
  // destructureParamObject (added in #852) does ref.test before ref.cast and falls
  // back to per-field __extern_get when the externref doesn't match the struct shape.
  // The earlier exclusion of binding elements caused #1543/#1544 illegal-cast failures
  // when async-gen-meth/for-of dstr-default fed externref `{}` into a typed dstr slot.
  if (expr.properties.length === 0 && !ts.isParameter(expr.parent)) {
    // Check contextual type: only use plain object when context is untyped or the `object` type
    // (TypeScript's `object` = NonPrimitive, used e.g. for Object.defineProperty's first arg).
    // Variable declarations without annotation have no contextual type → isAnyContext = true.
    const ctxType = ctx.checker.getContextualType(expr);
    const isAnyContext =
      !ctxType ||
      (ctxType.flags & ts.TypeFlags.Any) !== 0 ||
      (ctxType.flags & ts.TypeFlags.Unknown) !== 0 ||
      (ctxType.flags & ts.TypeFlags.NonPrimitive) !== 0; // TypeScript `object` keyword type
    // (#2542) An empty `{}` typed by a PURE string-index-signature contextual type
    // (`const o: { [s: string]: number } = {}`) is an open dictionary that will be
    // mutated by runtime string key (`o[k] = v`). Build it as an open `$Object`
    // (same `__new_plain_object` as the any-context arm) so the binding — which
    // resolveWasmType lowers to externref (#2542) — is a real `$Object` the native
    // `__extern_set`/`__extern_get` service. Host-free targets (standalone AND
    // wasi — see the #2542-follow-up note in index.ts's resolveWasmType guard);
    // gc/host keeps its existing lowering, since a JS host services `o[k]` there.
    const isPureStringIndexEmpty =
      (ctx.standalone || ctx.wasi) &&
      !!ctxType &&
      ctxType.getProperties().length === 0 &&
      !!ctx.checker.getIndexInfoOfType(ctxType, ts.IndexKind.String);
    // (#3076) defineProperty({}) receiver → open $Object (standalone/wasi;
    // rationale in isDefinePropertyReceiverLiteral, struct-accessor-closure.ts).
    if (isAnyContext || isPureStringIndexEmpty || isDefinePropertyReceiverLiteral(ctx, expr)) {
      const funcIdx = ensureLateImport(ctx, "__new_plain_object", [], [{ kind: "externref" }]);
      flushLateImportShifts(ctx, fctx);
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
        return { kind: "externref" };
      }
    }
  }

  // (#1901) Non-empty object literal flowing into an any/unknown/object
  // contextual type → build it as an open `$Object` at CONSTRUCTION rather than
  // a closed struct. A closed-struct literal coerced to externref then read by
  // string key (`function g(o:any){return o.x}` ← `g({x:9})`) returns 0 / emits
  // invalid Wasm standalone, because (1) the native object runtime is never
  // emitted for a closed-struct-only program and (2) `__extern_get`'s
  // `ref.test $Object` can't match a closed struct. Routing to the $Object path
  // here forces `ensureObjectRuntime` (via `__new_plain_object`) and yields the
  // $Object every native reader (__extern_get / __extern_method_call /
  // ToPrimitive valueOf/toString) already handles — unifying #1901 + #124.
  //
  // Mirrors the empty-{} any-context check above EXACTLY: only diverts when the
  // contextual type is genuinely non-specific (any / unknown / `object`) or
  // absent — a concrete struct type (typed param/var/dstr slot) keeps the
  // closed-struct fast path (#1472 R2) byte-identical. Accessor / disposal /
  // computed-symbol-key literals were already diverted to the host path above
  // (#1239/#1433). Skip parameter defaults (the struct system expects a typed
  // object for destructuring there), matching the empty-{} branch's exclusion.
  //
  // Scoped to `--target standalone` only: the open-object runtime
  // (`ensureObjectRuntime` / `__new_plain_object` / `__extern_get`) is emitted
  // as native defined functions exclusively under `ctx.standalone` (see #1472
  // Phase B + late-imports.ts:308 — WASI still uses the host-import object
  // machinery, intentionally deferred). Under wasi the $Object builder would
  // decline (`ensureLateImport` returns undefined for the runtime helpers),
  // fall through to the struct path, and leave a `ref.test $Object`-incompatible
  // closed struct + an unsatisfiable `env::__extern_get` read — the exact #1901
  // failure mode the gc/host R2 fast path avoids. Gating to `ctx.standalone`
  // keeps wasi byte-identical to main (the wasi extension is a tracked
  // follow-on; see plan/issues/1901). gc/host mode is untouched (not standalone).
  //
  // (#3536) EXCEPT when the Wasm-level EXPECTED type is this literal's OWN
  // shape struct. A literal in call-ARGUMENT position to a declared function
  // whose implicit-`any` param was call-site-narrowed (inferParamTypeFromCallSites
  // derived the param's struct FROM this literal's type) has TS-contextual type
  // `any` — so the #1901 diversion below would build a dynamic `$Object`, and
  // the call-boundary coercion's guarded cast (externref → shape struct) can
  // never match → the callee's param silently arrives NULL. That is the
  // `built-ins/RegExp/property-escapes` 311-row cluster (`buildString({...})`
  // in regExpUtils.js) and the wider "Cannot access property on null or
  // undefined [in <fn>]" masked family. When the literal's own struct
  // resolution lands EXACTLY on the expected typeIdx, construct the closed
  // struct — the same representation the var-init position already picks
  // (`var obj = {...}; f(obj)` passes today) — so the argument matches the
  // narrowed param by construction. Precise by design: the routing fires ONLY
  // on typeIdx equality, so an expected `$Object` / class / vec / AnyValue
  // type can never divert a literal that would not have lowered to that exact
  // struct anyway.
  // (#4394) The literal's own shape is a DIFFERENT struct from the expected one
  // because it OMITS optional fields the parameter declares. That is the
  // ordinary shape of a JSDoc-typed harness parameter under `allowJs` —
  //
  //   /** @param {object} [options]
  //    *  @param {boolean} [options.label]
  //    *  @param {boolean} [options.restore] */
  //   function verifyProperty(obj, name, desc, options) { … }
  //   verifyProperty(obj, prop, desc, { restore: true });   // propertyHelper.js
  //
  // The argument lowered to `struct.new <{restore}>` followed by the
  // call-boundary guarded downcast to `<{label,restore}>`, which cannot match —
  // and a failed guarded cast yields `ref.null`, so the callee's `options`
  // arrived as NULL. `options && options.restore` was then false and
  // `verifyProperty`'s `{ restore: true }` contract silently did nothing.
  //
  // Build the literal directly AS the expected struct instead, defaulting the
  // absent optional fields — exactly what `compileObjectLiteralForStruct`
  // already does for a field the literal does not mention. Scoped so it can only
  // ever REPLACE a cast that was going to fail (see the helper's contract).
  if (
    expectedType !== undefined &&
    (expectedType.kind === "ref" || expectedType.kind === "ref_null") &&
    expr.properties.length > 0
  ) {
    const diverted = tryCompileObjectLiteralAsExpectedStruct(ctx, fctx, expr, expectedType.typeIdx);
    if (diverted !== undefined) return diverted;
  }

  if (
    ctx.standalone &&
    expectedType !== undefined &&
    (expectedType.kind === "ref" || expectedType.kind === "ref_null") &&
    expr.properties.length > 0
  ) {
    // oracle-ratchet-allow (#3536, granted in the issue frontmatter): this
    // query needs the raw type IDENTITY for resolveStructName's anonTypeMap /
    // structMap lookup — a wasm-lowering ValType question deliberately above
    // what the oracle expresses (its header assigns struct registration to
    // the caller).
    let litType: ts.Type | undefined;
    try {
      litType = ctx.checker.getTypeAtLocation(expr);
    } catch {
      litType = undefined;
    }
    if (litType) {
      let litStructName = resolveStructName(ctx, litType);
      if (!litStructName) {
        ensureStructForType(ctx, litType);
        litStructName = resolveStructName(ctx, litType);
      }
      if (litStructName !== undefined && ctx.structMap.get(litStructName) === expectedType.typeIdx) {
        ensureComputedPropertyFields(ctx, fctx, expr, litType);
        return compileObjectLiteralForStruct(ctx, fctx, expr, litStructName);
      }
    }
  }
  if (objectLiteralTakesStandaloneAnyObjectPath(ctx, expr)) {
    const objResult = compileObjectLiteralAsExternref(ctx, fctx, expr);
    if (objResult) return objResult;
    // fall through to the struct path if the $Object builder declined.
  }

  // (#4208) A checker-identical `var` binding repeatedly initialized with
  // different valueOf/toString-only literal shapes cannot use a closed struct:
  // the sibling shape fails the guarded store and the next coercion sees null.
  // The pre-pass pins only the exact initializer nodes, so unrelated locals
  // named `object` retain their existing representation.
  if (ctx.ordinaryToPrimitiveObjectLiterals.has(expr)) {
    const ordinaryObject = compileObjectLiteralAsExternref(ctx, fctx, expr);
    if (ordinaryObject) return ordinaryObject;
  }

  // (#2837) A NON-EMPTY object literal initializing a variable that the detection
  // pre-pass (collectGrowableObjectLiterals) marked growable — i.e. it later
  // receives an OUT-OF-SHAPE property write (direct unknown key, or a nested
  // depth-≥2 write onto a descriptor object, the acorn
  // `prototypeAccessors.inFunction.get = fn` idiom). Build it as an open `$Object`
  // via the EXISTING recursive externref builder rather than a closed struct
  // (whose unknown-field writes lower to `drop` and reads to `ref.null extern`).
  // NOT standalone-gated: `compileObjectLiteralAsExternref` works in host mode
  // (`__new_plain_object` + `__extern_set`), which is the mode the NM differential
  // compiles in; the #1901 `ctx.standalone` gate above is a DECISION gate for the
  // any-context route, not a builder limitation. Placed BEFORE the closed-struct
  // contextType resolution so a marked var never reaches `compileObjectLiteralForStruct`.
  // The builder recurses on nested object-literal values (literals.ts:298), so the
  // nested descriptor objects are built growable automatically. The local typing in
  // variables.ts makes the binding externref in lockstep. If the builder declines
  // (methods/accessors/computed keys), fall through to the existing paths.
  if (
    expr.properties.length > 0 &&
    ts.isVariableDeclaration(expr.parent) &&
    ts.isIdentifier(expr.parent.name) &&
    (ctx.growableObjectLiteralVars.has(expr.parent.name.text) ||
      ctx.irWithOpenObjectTargetKeys.has(widenedVarKeyFromDecl(expr.parent.name)))
  ) {
    const growableResult = compileObjectLiteralAsExternref(ctx, fctx, expr);
    if (growableResult) return growableResult;
    // builder declined — fall through to the struct paths below.
  }

  const contextType = ctx.checker.getContextualType(expr);
  if (!contextType) {
    // #1606: `getTypeAtLocation` can crash inside TypeScript's `checkObjectLiteral`
    // for object literals parsed from a foreign SourceFile (e.g. statically inlined
    // `eval("({foo:0,foo:1})")` bodies) — the checker has no binding for the
    // duplicate-property symbol and dereferences `.flags` on undefined. Fall back
    // to the externref plain-object lowering instead of crashing the compile.
    let type: ts.Type | undefined;
    try {
      type = ctx.checker.getTypeAtLocation(expr);
    } catch {
      const fallback = compileObjectLiteralAsExternref(ctx, fctx, expr);
      if (fallback) return fallback;
      reportError(ctx, expr, "Cannot determine struct type for object literal");
      return null;
    }
    let typeName = resolveStructName(ctx, type);
    if (!typeName) {
      // Auto-register the struct type for inline object literals
      ensureStructForType(ctx, type);
      typeName = resolveStructName(ctx, type);
    }
    if (typeName) {
      ensureComputedPropertyFields(ctx, fctx, expr, type);
      return compileObjectLiteralForStruct(ctx, fctx, expr, typeName);
    }
    // Fall back to externref plain object for unmappable types (e.g. {...null})
    const fallback = compileObjectLiteralAsExternref(ctx, fctx, expr);
    if (fallback) return fallback;
    reportError(ctx, expr, "Cannot determine struct type for object literal");
    return null;
  }

  let typeName = resolveStructName(ctx, contextType);
  if (!typeName) {
    // Auto-register the struct type for the contextual type
    ensureStructForType(ctx, contextType);
    typeName = resolveStructName(ctx, contextType);
  }
  if (typeName) {
    ensureComputedPropertyFields(ctx, fctx, expr, contextType);
    return compileObjectLiteralForStruct(ctx, fctx, expr, typeName);
  }

  // Contextual type couldn't be mapped; fall back to inferred type-at-location
  const inferredType = ctx.checker.getTypeAtLocation(expr);
  let inferredName = resolveStructName(ctx, inferredType);
  if (!inferredName) {
    ensureStructForType(ctx, inferredType);
    inferredName = resolveStructName(ctx, inferredType);
  }
  if (inferredName) {
    ensureComputedPropertyFields(ctx, fctx, expr, inferredType);
    return compileObjectLiteralForStruct(ctx, fctx, expr, inferredName);
  }

  // Fall back to externref plain object for unmappable types
  const fallback = compileObjectLiteralAsExternref(ctx, fctx, expr);
  if (fallback) return fallback;

  reportError(ctx, expr, "Object literal type not mapped to struct");
  return null;
}

/**
 * Try to evaluate an expression to a constant numeric or string value at compile time.
 * Supports: numeric literals, string literals, simple arithmetic (+, -, *, /),
 * and const variable references.
 * Returns the resolved value (number or string) or undefined if not resolvable.
 */
export function resolveConstantExpression(ctx: CodegenContext, expr: ts.Expression): number | string | undefined {
  if (ts.isNumericLiteral(expr)) return Number(expr.text);

  // Boolean literals
  if (expr.kind === ts.SyntaxKind.TrueKeyword) return 1;
  if (expr.kind === ts.SyntaxKind.FalseKeyword) return 0;
  if (expr.kind === ts.SyntaxKind.NullKeyword) return "null";
  if (ts.isStringLiteral(expr)) return expr.text;

  // Parenthesized expression
  if (ts.isParenthesizedExpression(expr)) {
    return resolveConstantExpression(ctx, expr.expression);
  }

  // Const variable reference
  if (ts.isIdentifier(expr)) {
    const sym = ctx.checker.getSymbolAtLocation(expr);
    if (sym) {
      const decl = sym.valueDeclaration;
      if (decl && ts.isVariableDeclaration(decl) && decl.initializer) {
        const declList = decl.parent;
        if (ts.isVariableDeclarationList(declList) && (declList.flags & ts.NodeFlags.Const) !== 0) {
          return resolveConstantExpression(ctx, decl.initializer);
        }
        // Also resolve let/var with simple literal initializers
        if (ts.isVariableDeclarationList(declList) && decl.initializer) {
          if (ts.isStringLiteral(decl.initializer) || ts.isNumericLiteral(decl.initializer)) {
            return ts.isStringLiteral(decl.initializer) ? decl.initializer.text : String(Number(decl.initializer.text));
          }
        }
      }
    }
    return undefined;
  }

  // Assignment expression: x = value → resolve to the RHS value
  // This handles computed property names like [_ = 'str' + 'ing']
  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    return resolveConstantExpression(ctx, expr.right);
  }

  // A logical-AND assignment whose left hand side is statically falsy has no
  // observable write and evaluates to the existing value.  Class computed
  // names are collected before their initializer bodies are emitted, so this
  // narrow fold lets e.g. `let x = 0; class C { [x &&= 1] = 2 }` use the
  // canonical property name "0" while preserving the specified `x === 0`.
  // Do not fold the truthy arm (or ||= / ??=): those forms perform a write and
  // must remain runtime expressions until a side-effect-aware evaluator exists.
  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandEqualsToken) {
    const leftValue = resolveConstantExpression(ctx, expr.left);
    if (leftValue === undefined) return undefined;
    const leftType = ctx.checker.getTypeAtLocation(expr.left);
    const leftIsFalsy =
      (leftType.flags & ts.TypeFlags.Null) !== 0 ||
      (leftType.flags & ts.TypeFlags.Undefined) !== 0 ||
      (leftType.flags & ts.TypeFlags.NumberLike) !== 0
        ? Number(leftValue) === 0 || Number.isNaN(Number(leftValue))
        : typeof leftValue === "string" && leftValue.length === 0;
    return leftIsFalsy ? leftValue : undefined;
  }

  // Binary expression: a + b, a - b, a * b, a / b
  if (ts.isBinaryExpression(expr)) {
    const left = resolveConstantExpression(ctx, expr.left);
    const right = resolveConstantExpression(ctx, expr.right);
    if (left === undefined || right === undefined) return undefined;

    // String concatenation
    if (typeof left === "string" || typeof right === "string") {
      if (expr.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        return String(left) + String(right);
      }
      return undefined;
    }

    switch (expr.operatorToken.kind) {
      case ts.SyntaxKind.PlusToken:
        return left + right;
      case ts.SyntaxKind.MinusToken:
        return left - right;
      case ts.SyntaxKind.AsteriskToken:
        return left * right;
      case ts.SyntaxKind.SlashToken:
        return right !== 0 ? left / right : undefined;
      case ts.SyntaxKind.PercentToken:
        return right !== 0 ? left % right : undefined;
      case ts.SyntaxKind.AsteriskAsteriskToken:
        return left ** right;
      default:
        return undefined;
    }
  }

  // Prefix unary: -x, +x
  if (ts.isPrefixUnaryExpression(expr)) {
    const operand = resolveConstantExpression(ctx, expr.operand);
    if (typeof operand !== "number") return undefined;
    switch (expr.operator) {
      case ts.SyntaxKind.MinusToken:
        return -operand;
      case ts.SyntaxKind.PlusToken:
        return operand;
      default:
        return undefined;
    }
  }

  // Conditional (ternary) expression: cond ? a : b
  if (ts.isConditionalExpression(expr)) {
    const cond = resolveConstantExpression(ctx, expr.condition);
    if (cond === undefined) return undefined;
    // Evaluate truthiness: 0, NaN, "" are falsy; everything else is truthy
    const isTruthy = typeof cond === "string" ? cond.length > 0 : cond !== 0 && !isNaN(cond);
    return resolveConstantExpression(ctx, isTruthy ? expr.whenTrue : expr.whenFalse);
  }

  // Nullish coalescing: a ?? b
  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
    const left = resolveConstantExpression(ctx, expr.left);
    // In constant expressions, values are never null/undefined, so left always wins
    if (left !== undefined) return left;
    return resolveConstantExpression(ctx, expr.right);
  }

  // Template literal: `prefix${expr}suffix`
  if (ts.isTemplateExpression(expr)) {
    let result = expr.head.text;
    for (const span of expr.templateSpans) {
      const val = resolveConstantExpression(ctx, span.expression);
      if (val === undefined) return undefined;
      result += String(val) + span.literal.text;
    }
    return result;
  }

  // No-substitution template literal: `hello`
  if (ts.isNoSubstitutionTemplateLiteral(expr)) {
    return expr.text;
  }

  // Call expressions: String(expr), Number(expr)
  if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression) && expr.arguments.length === 1) {
    const funcName = expr.expression.text;
    const argVal = resolveConstantExpression(ctx, expr.arguments[0]!);
    if (argVal !== undefined) {
      if (funcName === "String") return String(argVal);
      if (funcName === "Number") return typeof argVal === "string" ? Number(argVal) : argVal;
    }
  }

  return undefined;
}

/**
 * (#3099) True for a method-shorthand property with a PLAIN compile-time key
 * (`m() {}`, `"m"() {}`, `0() {}`) — the shapes `compileObjectLiteralAsExternref`
 * materializes as a runtime own-property closure. Computed / well-known-symbol
 * method keys (`[Symbol.iterator]() {}`, `[expr]() {}`) return false so they keep
 * routing to the accessor / host / struct path upstream, which handles the
 * Symbol-boxing those require.
 */
export function isPlainNamedMethodDeclaration(prop: ts.ObjectLiteralElementLike): boolean {
  return (
    ts.isMethodDeclaration(prop) &&
    (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) || ts.isNumericLiteral(prop.name))
  );
}

/**
 * Resolve the property name of an ObjectLiteralElementLike to a static string.
 * Handles identifiers, string literals, and computed property names that can be
 * evaluated at compile time (string literal expressions, const variables, enum members).
 * Returns undefined if the name cannot be statically resolved.
 */
export function resolvePropertyNameText(ctx: CodegenContext, prop: ts.ObjectLiteralElementLike): string | undefined {
  // #2010: a shorthand `{ x }` carries its key as `prop.name` (an Identifier).
  // Treat it like `{ x: x }` so the open-$Object construction path
  // (compileObjectLiteralAsExternref) does not skip it — previously this returned
  // undefined for shorthands, so a literal mixing a shorthand with a spread
  // (`{ x, ...null }`) dropped the shorthand binding entirely.
  if (ts.isShorthandPropertyAssignment(prop)) return prop.name.text;
  if (!ts.isPropertyAssignment(prop)) return undefined;
  const name = prop.name;

  // Regular identifier: { x: 1 }
  if (ts.isIdentifier(name)) return name.text;

  // String literal property name: { "x": 1 }
  if (ts.isStringLiteral(name)) return name.text;

  // Numeric literal property name: { 0: 1 } → canonical string form
  if (ts.isNumericLiteral(name)) return String(Number(name.text));

  // Computed property name: { [expr]: 1 }
  if (ts.isComputedPropertyName(name)) {
    return resolveComputedKeyExpression(ctx, name.expression);
  }

  return undefined;
}

/**
 * Well-known symbol IDs — fixed i32 constants used internally.
 * User-created symbols start at ID 100 via the global counter.
 */
const WELL_KNOWN_SYMBOLS: Record<string, number> = {
  iterator: 1,
  hasInstance: 2,
  toPrimitive: 3,
  toStringTag: 4,
  species: 5,
  isConcatSpreadable: 6,
  match: 7,
  replace: 8,
  search: 9,
  split: 10,
  unscopables: 11,
  asyncIterator: 12,
  dispose: 13,
  asyncDispose: 14,
  matchAll: 15,
};

/**
 * Map a well-known Symbol property name (e.g. "iterator") to a reserved
 * property key string "@@iterator" for use as struct field names.
 */
export function resolveWellKnownSymbol(name: string): string | undefined {
  if (name in WELL_KNOWN_SYMBOLS) return `@@${name}`;
  return undefined;
}

/**
 * Get the i32 constant for a well-known symbol, or undefined if not well-known.
 */
export function getWellKnownSymbolId(name: string): number | undefined {
  return WELL_KNOWN_SYMBOLS[name];
}

/**
 * Ensure the __symbol_counter mutable global exists (lazy init).
 * Starts at 100 so well-known symbol IDs (1-12) never collide.
 */
export function ensureSymbolCounter(ctx: CodegenContext): number {
  if (ctx.symbolCounterGlobalIdx >= 0) return ctx.symbolCounterGlobalIdx;
  const idx = nextModuleGlobalIdx(ctx);
  ctx.mod.globals.push({
    name: "__symbol_counter",
    type: { kind: "i32" },
    mutable: true,
    init: [{ op: "i32.const", value: 100 }],
  });
  ctx.symbolCounterGlobalIdx = idx;
  return idx;
}

/**
 * Compile a Symbol() call — returns a unique i32 by incrementing a global counter.
 * The description argument (if any) is evaluated for side effects but discarded.
 */
export function compileSymbolCall(ctx: CodegenContext, fctx: FunctionContext, args: readonly ts.Expression[]): ValType {
  if (usesNativeSymbolProvider(ctx)) ensureNativeSymbolBoundaryBridge(ctx);
  const counterIdx = ensureSymbolCounter(ctx);
  // Increment counter first so the new id is reserved before we register a
  // description for it: `++counter; register_desc(counter, desc); return counter`.
  fctx.body.push({ op: "global.get", index: counterIdx });
  fctx.body.push({ op: "i32.const", value: 1 });
  fctx.body.push({ op: "i32.add" });
  fctx.body.push({ op: "global.set", index: counterIdx });
  // (#1467) Pre-register the description so `__box_symbol(id)` later returns
  // `Symbol(desc)` instead of `Symbol("wasm_<id>")`. This preserves
  // `Symbol(s).description === s` and `Symbol().description === undefined`.
  // Standalone-mode fallback: if the host import isn't available, the symbol
  // is still constructed (with the legacy `wasm_<id>` description); only the
  // `.description` accessor in JS-host mode benefits.
  //
  // (#2163) In no-JS-host mode (`--target standalone` / `--target wasi`) there
  // is no host to register the description with, so emitting the
  // `env::__symbol_register_desc` import leaves it unsatisfiable and the module
  // fails to instantiate — making EVERY `Symbol()` call a runtime failure
  // standalone. The symbol value itself is just the i32 counter id (which is
  // all `typeof s === "symbol"` and symbol identity/distinctness need), so the
  // host registration is a pure JS-host fast path. Skip it standalone and only
  // evaluate the description argument for side effects.
  const nativeSymbolProvider = usesNativeSymbolProvider(ctx);
  const regIdx = nativeSymbolProvider
    ? undefined
    : ensureLateImport(ctx, "__symbol_register_desc", [{ kind: "i32" }, { kind: "externref" }], []);
  if (regIdx !== undefined) {
    fctx.body.push({ op: "global.get", index: counterIdx });
    if (args.length > 0) {
      const argType = compileExpression(ctx, fctx, args[0]!, { kind: "externref" });
      if (argType && argType.kind !== "externref") {
        coerceType(ctx, fctx, argType, { kind: "externref" });
      }
    } else {
      // `Symbol()` with no arg → register `null` so the host knows to construct
      // a Symbol with no description (so `.description === undefined`).
      fctx.body.push({ op: "ref.null.extern" });
    }
    flushLateImportShifts(ctx, fctx);
    fctx.body.push({ op: "call", funcIdx: regIdx });
  } else if (args.length > 0) {
    // (#2163) Standalone / no-JS-host mode: store the description in the native
    // id→string side table so `sym.description` can read it back without a host
    // import. §20.4.1.1: if the description argument is `undefined`, the symbol
    // has NO description (`.description === undefined`), so a literal
    // `Symbol(undefined)` must NOT register a description — but it still
    // evaluates the argument for side effects.
    const argExpr = args[0]!;
    const isUndefinedLiteral =
      ts.isIdentifier(argExpr) &&
      argExpr.text === "undefined" &&
      ctx.checker.getSymbolAtLocation(argExpr) === undefined;
    const argType = compileExpression(ctx, fctx, argExpr, { kind: "ref_null", typeIdx: ctx.anyStrTypeIdx });
    if (argType === null) {
      // expression produced no value — nothing to store.
    } else if (isUndefinedLiteral) {
      // Per spec, no description; discard the evaluated value.
      if (argType.kind !== "ref_null" || argType.typeIdx !== ctx.anyStrTypeIdx) {
        // value left on stack in some other type — drop it directly.
      }
      fctx.body.push({ op: "drop" });
    } else {
      // Coerce the description to a `ref_null $AnyString` and store it at the
      // reserved id: `store(id, desc)` consumes both off the stack.
      if (argType.kind !== "ref_null" || argType.typeIdx !== ctx.anyStrTypeIdx) {
        coerceType(ctx, fctx, argType, { kind: "ref_null", typeIdx: ctx.anyStrTypeIdx });
      }
      // emitSymbolDescStore wants `[id, desc]`; the desc is on top, so push id
      // BELOW it via a temp.
      const descTmp = allocLocal(fctx, `__symdesc_arg_${fctx.locals.length}`, {
        kind: "ref_null",
        typeIdx: ctx.anyStrTypeIdx,
      });
      fctx.body.push({ op: "local.set", index: descTmp });
      fctx.body.push({ op: "global.get", index: counterIdx });
      fctx.body.push({ op: "local.get", index: descTmp });
      emitSymbolDescStore(ctx, fctx);
    }
  }
  // Push the symbol id (the counter) as the result.
  fctx.body.push({ op: "global.get", index: counterIdx });
  // (#4626) Carry the symbol BRAND on the i32 id ONLY in the native-symbol
  // lanes (standalone/wasi), so any-channel coercions box via __box_symbol
  // (interned $Symbol carrier), not __box_number — unbranded, `typeof
  // t(Symbol())` through an any param answered "number" and defineProperty/
  // sameValue treated symbols as numbers whenever the checker type was not
  // consulted. The js-host lane MUST stay unbranded: branding it routed
  // mid-emission coercions through the `ensureLateImport(__box_symbol)` arm,
  // whose late host-import insertion shifted baked function indices (#608/
  // #794) — 216 "invalid Wasm binary" regressions in the 2026-08-23
  // merge_group (Temporal/JSON/Array buckets).
  if (nativeSymbolProvider) return { kind: "i32", symbol: true };
  return { kind: "i32" };
}

/**
 * Try to evaluate a computed key expression to a static string at compile time.
 * Supports:
 * - String literals: ["x"]
 * - Const variable references: [key] where const key = "x"
 * - Enum member access: [MyEnum.Key]
 */
export function resolveComputedKeyExpression(ctx: CodegenContext, expr: ts.Expression): string | undefined {
  // Well-known Symbol property access: [Symbol.iterator], [Symbol.toPrimitive], etc.
  // Map these to reserved names like "@@iterator", "@@toPrimitive" at compile time.
  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression)) {
    const objName = expr.expression.text;
    const propName = expr.name.text;

    if (objName === "Symbol") {
      const wellKnown = resolveWellKnownSymbol(propName);
      if (wellKnown !== undefined) return wellKnown;
    }

    // Property access for enum members: [MyEnum.Key]
    // Check this after Symbol since resolveConstantExpression doesn't know about enums.
    const enumKey = `${objName}.${propName}`;
    const enumStrVal = ctx.enumStringValues.get(enumKey);
    if (enumStrVal !== undefined) return enumStrVal;
    // Numeric enum — convert to string
    const enumNumVal = ctx.enumValues.get(enumKey);
    if (enumNumVal !== undefined) return String(enumNumVal);
  }

  // Delegate to resolveConstantExpression which handles literals, const variables,
  // binary expressions (+, -, *, /), ternary, nullish coalescing, template literals,
  // prefix unary, and parenthesized expressions.
  const constVal = resolveConstantExpression(ctx, expr);
  if (constVal !== undefined) return String(constVal);

  return undefined;
}

/**
 * Resolve the property name of a getter/setter accessor to a static string.
 * Handles identifiers, string literals, numeric literals, and computed property names.
 */
export function resolveAccessorPropName(ctx: CodegenContext, name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name)) return name.text;
  if (ts.isNumericLiteral(name)) return String(Number(name.text));
  if (ts.isComputedPropertyName(name)) {
    return resolveComputedKeyExpression(ctx, name.expression);
  }
  return undefined;
}

/**
 * (#4394) Record the closure struct type(s) a `valueOf`/`toString` eqref field
 * may hold, so the per-instance `__call_valueOf`/`__call_toString` dispatchers
 * (`closure-eqref-multi`, index.ts) get a candidate to `ref.test`. Extends the
 * old inline PropertyAssignment-only flat scan on two axes that deepEqual.js
 * exposed:
 *   - the value expression may build its closure NESTED inside an `if` (the
 *     lazy singleton / memoized nested-fn shapes emit `struct.new` inside the
 *     init arm), which a flat `fctx.body[bi]` walk never saw;
 *   - the value may only REFERENCE an already-built closure (`global.get` +
 *     `ref.cast`), with no `struct.new` at this site at all — so `ref.cast`/
 *     `ref.cast_null`/`ref.test` of a registered closure type counts too.
 * Shorthand `{ toString }` (the deepEqual.js idiom) now calls this as well.
 */
function trackToPrimitiveClosureTypes(
  ctx: CodegenContext,
  fctx: FunctionContext,
  typeName: string,
  field: { name: string; type: ValType },
  bodyLenBefore: number,
): void {
  if (field.name !== "valueOf" && field.name !== "toString") return;
  if (field.type.kind !== "eqref") return;
  const record = (typeIdx: number): void => {
    if (!ctx.closureInfoByTypeIdx.has(typeIdx)) return;
    const existing = ctx.valueOfClosureTypes.get(typeName) ?? [];
    if (!existing.includes(typeIdx)) {
      existing.push(typeIdx);
      ctx.valueOfClosureTypes.set(typeName, existing);
    }
  };
  const walk = (instrs: Instr[]): void => {
    for (const instr of instrs) {
      const op = instr.op;
      if (op === "struct.new" || op === "ref.cast" || op === "ref.cast_null" || op === "ref.test") {
        const typeIdx = (instr as { typeIdx?: number }).typeIdx;
        if (typeIdx !== undefined) record(typeIdx);
      }
      for (const key of ["body", "then", "else", "catchAll"] as const) {
        const nested = (instr as unknown as Record<string, unknown>)[key];
        if (Array.isArray(nested)) walk(nested as Instr[]);
      }
      const catches = (instr as { catches?: { body?: Instr[] }[] }).catches;
      if (Array.isArray(catches)) {
        for (const c of catches) if (Array.isArray(c.body)) walk(c.body);
      }
    }
  };
  walk(fctx.body.slice(bodyLenBefore));
}

/**
 * Compile an empty object literal ({}) that has widened properties from
 * later property assignments (e.g. `var obj = {}; obj.x = 42;`).
 * Registers a struct type with the widened fields and emits struct.new
 * with default values for each field.
 */
export function compileWidenedEmptyObject(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.ObjectLiteralExpression,
  widenedProps: { name: string; type: ValType }[],
): ValType | null {
  // The struct was already registered during the pre-pass (collectEmptyObjectWidening).
  // Look it up via the anonTypeMap, or the widenedVarStructMap (which holds the pre-pass
  // registration even for `any`-typed vars that must skip anonTypeMap to avoid polluting
  // the singleton `any` type object).
  const type = ctx.checker.getTypeAtLocation(expr);
  let typeName = ctx.anonTypeMap.get(type);
  if (!typeName && ts.isVariableDeclaration(expr.parent) && ts.isIdentifier(expr.parent.name)) {
    const varType = ctx.checker.getTypeAtLocation(expr.parent.name);
    typeName = ctx.anonTypeMap.get(varType);
  }
  if (!typeName && ts.isVariableDeclaration(expr.parent) && ts.isIdentifier(expr.parent.name)) {
    typeName = ctx.widenedVarStructMap.get(widenedVarKeyFromDecl(expr.parent.name));
  }
  if (!typeName) {
    // Fallback: the pre-pass should have registered it but didn't match type identity.
    // Search by variable name in the struct map.
    if (ts.isVariableDeclaration(expr.parent) && ts.isIdentifier(expr.parent.name)) {
      // Register now as a last resort
      // Widen ref to ref_null so struct.new can use ref.null defaults
      const fields: FieldDef[] = widenedProps.map((wp) => ({
        name: wp.name,
        type:
          wp.type.kind === "ref"
            ? { kind: "ref_null" as const, typeIdx: (wp.type as { typeIdx: number }).typeIdx }
            : wp.type,
        mutable: true,
      }));
      typeName = `__anon_${ctx.anonTypeCounter++}`;
      const typeIdx = ctx.mod.types.length;
      ctx.mod.types.push({
        kind: "struct",
        name: typeName,
        fields,
      } as StructTypeDef);
      ctx.structMap.set(typeName, typeIdx);
      ctx.typeIdxToStructName.set(typeIdx, typeName);
      ctx.structFields.set(typeName, fields);
      // Skip anonTypeMap registration for `any` — it's a singleton type object shared by
      // all any-typed vars, so registering it would pollute every any-typed var's lookup.
      if (!(type.flags & ts.TypeFlags.Any)) {
        ctx.anonTypeMap.set(type, typeName);
      }
      const varType = ctx.checker.getTypeAtLocation(expr.parent.name);
      if (!(varType.flags & ts.TypeFlags.Any)) {
        ctx.anonTypeMap.set(varType, typeName);
      }
      // Record via widenedVarStructMap so later lookups still find it for any-typed vars.
      ctx.widenedVarStructMap.set(widenedVarKeyFromDecl(expr.parent.name), typeName);
    }
  }
  if (!typeName) return null;

  const structTypeIdx = ctx.structMap.get(typeName);
  const fields = ctx.structFields.get(typeName);
  if (structTypeIdx === undefined || !fields) return null;

  // Emit default values for each field
  for (const field of fields) {
    switch (field.type.kind) {
      case "f64":
        fctx.body.push({ op: "f64.const", value: 0 });
        break;
      case "i32":
        fctx.body.push({ op: "i32.const", value: 0 });
        break;
      case "externref":
        // (#3042) A widened `externref` field that is never assigned — e.g. a
        // property introduced ONLY through `Object.defineProperty(obj, k, desc)`
        // with a value-less descriptor (`{ enumerable: false }`), which lowers to
        // a struct no-op — must read back as JS `undefined`, not `null`. Per ES
        // §10.1.6.3 a value-less data descriptor defaults `[[Value]]` to
        // `undefined`; reading a would-be-absent property likewise yields
        // `undefined`. `ref.null.extern` reads as `null` and breaks the
        // defineProperty attribute round-trip (verifyProperty's `value:
        // undefined` check). Mirror the established default-value semantics of
        // the main object-literal path (its "missing fields" branch), which uses
        // `emitUndefined` for exactly this reason.
        emitUndefined(ctx, fctx);
        break;
      default:
        if (field.type.kind === "ref" || field.type.kind === "ref_null") {
          fctx.body.push({ op: "ref.null", typeIdx: (field.type as { typeIdx: number }).typeIdx });
        } else {
          fctx.body.push({ op: "f64.const", value: 0 });
        }
    }
  }
  fctx.body.push({ op: "struct.new", typeIdx: structTypeIdx });
  return { kind: "ref", typeIdx: structTypeIdx };
}

/**
 * (#4616) The struct-field "missing property" default — undefined sentinels so
 * destructuring default-value checks can detect absence (f64: the sNaN
 * sentinel matching emitDefaultValueCheck #866; externref: JS `undefined`, not
 * ref.null.extern, because destructuring defaults fire only on `=== undefined`).
 * Shared by the spread null-guard arms and the no-writer fallback below.
 */
function pushStructFieldDefault(ctx: CodegenContext, fctx: FunctionContext, fieldType: ValType): void {
  if (fieldType.kind === "f64") {
    fctx.body.push({ op: "i64.const", value: 0x7ff00000deadc0den });
    fctx.body.push({ op: "f64.reinterpret_i64" });
  } else if (fieldType.kind === "externref") {
    emitUndefined(ctx, fctx);
  } else if (fieldType.kind === "eqref") {
    fctx.body.push({ op: "ref.null.eq" });
  } else if (fieldType.kind === "ref" || fieldType.kind === "ref_null") {
    fctx.body.push({ op: "ref.null", typeIdx: fieldType.typeIdx });
  } else {
    fctx.body.push({ op: "i32.const", value: 0 });
  }
}

/**
 * (#4616) Block result type for the spread null-guard `if`: a bare `ref`
 * field type is widened to `ref_null` so the null-arm's `ref.null` default
 * validates (struct fields land as nullable refs in the emitted type section).
 */
function spreadGuardBlockType(fieldType: ValType): ValType {
  if (fieldType.kind === "ref") return { kind: "ref_null", typeIdx: fieldType.typeIdx };
  return fieldType;
}

/**
 * (#4616) Read `fieldIdx` from a spread source struct with an ABSENT-slot
 * fallback. A partial source (`{ ...defaults, ...options }` where `options`
 * lacks some optional keys) stores the MISSING sentinel in the unset slots
 * (externref: JS undefined; f64: the #866 sNaN), and §13.2.5.5
 * CopyDataProperties copies only OWN PRESENT properties — so a sentinel read
 * must keep the earlier writer's value, not clobber it. i32/ref slots carry
 * no sentinel and read through unchanged (known residual: an absent optional
 * boolean cannot be told from `false`).
 */
function spreadFieldReadWithAbsentFallback(
  ctx: CodegenContext,
  fctx: FunctionContext,
  src: { local: number; srcStructTypeIdx: number },
  fieldIdx: number,
  fieldType: ValType,
  fallback: Instr[],
): Instr[] {
  const read: Instr[] = [
    { op: "local.get", index: src.local },
    { op: "struct.get", typeIdx: src.srcStructTypeIdx, fieldIdx },
  ];
  if (fieldType.kind === "externref") {
    const isUndefIdx = ctx.funcMap.get("__extern_is_undefined");
    if (isUndefIdx === undefined) return read;
    const vTmp = allocTempLocal(fctx, { kind: "externref" });
    const out: Instr[] = [
      ...read,
      { op: "local.tee", index: vTmp },
      { op: "call", funcIdx: isUndefIdx },
      {
        op: "if",
        blockType: { kind: "val", type: fieldType },
        then: fallback,
        else: [{ op: "local.get", index: vTmp }],
      },
    ];
    releaseTempLocal(fctx, vTmp);
    return out;
  }
  if (fieldType.kind === "f64") {
    const vTmp = allocTempLocal(fctx, { kind: "f64" });
    const out: Instr[] = [
      ...read,
      { op: "local.tee", index: vTmp },
      { op: "i64.reinterpret_f64" },
      { op: "i64.const", value: 0x7ff00000deadc0den },
      { op: "i64.eq" },
      {
        op: "if",
        blockType: { kind: "val", type: fieldType },
        then: fallback,
        else: [{ op: "local.get", index: vTmp }],
      },
    ];
    releaseTempLocal(fctx, vTmp);
    return out;
  }
  return read;
}

export function compileObjectLiteralForStruct(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.ObjectLiteralExpression,
  typeName: string,
): ValType | null {
  const structTypeIdx = ctx.structMap.get(typeName);
  const fields = ctx.structFields.get(typeName);
  if (structTypeIdx === undefined || !fields) {
    reportError(ctx, expr, `Unknown struct type: ${typeName}`);
    return null;
  }
  const mayHaveModuleHostSpreadField = isModuleGlobalObjectLiteral(expr);

  // Check if there are any spread assignments — if so, compile spread sources into locals.
  // (#2009 R3) `propIndex` records each spread's position in `expr.properties` so the
  // field-assembly loop can honour SOURCE ORDER between a named prop and a spread that
  // both write the same key (later writer wins — `{ x:1, ...{x:5} }` → `x:5`).
  const spreadSources: {
    local: number;
    srcStructTypeIdx: number;
    srcFields: { name: string }[];
    propIndex: number;
  }[] = [];
  for (let propIndex = 0; propIndex < expr.properties.length; propIndex++) {
    const prop = expr.properties[propIndex]!;
    if (ts.isSpreadAssignment(prop)) {
      let srcType = ctx.checker.getTypeAtLocation(prop.expression);
      // (#4616) An optional-param source types as `T | undefined`; strip the
      // nullish constituents so the struct resolution below sees the object
      // shape (the runtime null case is handled by the ref.is_null guards in
      // the field assembly — §13.2.5.5 skips a nullish source). Without this
      // the source silently dropped from `spreadSources` and the spread
      // contributed NOTHING (jest's `{ ...defaults, ...options }`).
      if (srcType.isUnion()) {
        const parts = srcType.types.filter((p) => (p.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)) === 0);
        if (parts.length === 1) srcType = parts[0]!;
      }
      // (#2009 R3) An INLINE object-literal spread source (`{ ...{ x: 1 } }`)
      // is never independently declared, so its anonymous object type was never
      // registered as a struct — `resolveStructName` returns undefined, the
      // source is dropped from `spreadSources`, and every spread-sourced field
      // falls through to the undefined-default branch below (the observed
      // `{ ...{x:1,y:2} }` → `{x:null,y:null}` bug). Register a struct for the
      // source type first (mirroring the outer-literal registration at the
      // `compileObjectLiteral` entry, lines ~921/938/950) so both
      // `resolveStructName` AND the `compileExpression` below lower it to a real
      // struct instance whose fields can be read. NAMED sources already work
      // (their declaration registered the struct), so this is a no-op for them.
      let srcStructName = resolveStructName(ctx, srcType);
      if (!srcStructName) {
        ensureStructForType(ctx, srcType);
        srcStructName = resolveStructName(ctx, srcType);
      }
      if (srcStructName) {
        const srcStructTypeIdx = ctx.structMap.get(srcStructName);
        const srcFields = ctx.structFields.get(srcStructName);
        if (srcStructTypeIdx !== undefined && srcFields) {
          const srcValType: ValType = { kind: "ref", typeIdx: srcStructTypeIdx };
          const srcLocal = allocLocal(fctx, `__spread_obj_${fctx.locals.length}`, srcValType);
          const spreadResult = compileExpression(ctx, fctx, prop.expression);
          if (!spreadResult) continue;
          fctx.body.push({ op: "local.set", index: srcLocal });
          spreadSources.push({ local: srcLocal, srcStructTypeIdx, srcFields, propIndex });
        }
      }
    }
  }
  // (#4616) The absent-slot fallback below tests externref reads against the
  // undefined singleton — register the helper BEFORE the field assembly so no
  // mid-assembly late-import shift can strand arm indices.
  if (spreadSources.length > 0) {
    ensureLateImport(ctx, "__extern_is_undefined", [{ kind: "externref" }], [{ kind: "i32" }]);
    flushLateImportShifts(ctx, fctx);
  }

  // (#2009 R3b) Record this literal's field names in JS INSERTION order so the
  // host name export (`__struct_field_names`) can enumerate keys in spec order.
  // The struct's slot order comes from `ts.Type.getProperties()`, which is
  // last-spread-first for spread-result types and therefore does NOT match the
  // §13.2.5 PropertyDefinitionEvaluation order. Walk `expr.properties` in source
  // order: a named/shorthand/method/accessor prop contributes its key; a spread
  // contributes its source's own field names in order. First occurrence fixes a
  // key's position (a later duplicate or override keeps the earlier slot, e.g.
  // `{...{a:1},...{b:2},...{a:3}}` → `a,b`). The first literal of a deduped
  // canonical type wins, so the result is deterministic by compile order and a
  // no-op for plain literals whose checker order already matches insertion order.
  if (!ctx.structInsertionOrder.has(typeName)) {
    const spreadByPropIndex = new Map<number, { name: string }[]>();
    for (const src of spreadSources) spreadByPropIndex.set(src.propIndex, src.srcFields);
    const insertionOrder: string[] = [];
    const seen = new Set<string>();
    // `written` = the key appears literally in this object literal's source, so
    // it is unambiguously a USER property even when it starts with `$` / `__`
    // (`{ $$typeof: … }` — React tags every element that way, and jQuery-style
    // `$`-prefixed keys are common generally). The compiler's own hidden slots
    // (`$shape`, `$arity`, `__tag`) never come through this path.
    //
    // Spread sources are different: their name list is the SOURCE STRUCT's slot
    // names, which do mix user keys with those hidden slots. There is no way to
    // tell them apart here, so the prefix heuristic is kept for that path —
    // conservative, and exactly the previous behaviour.
    const pushName = (n: string | undefined, written: boolean): void => {
      if (n === undefined) return;
      if (!written && (n.startsWith("$") || n.startsWith("__"))) return;
      if (seen.has(n)) return;
      seen.add(n);
      insertionOrder.push(n);
    };
    for (let pi = 0; pi < expr.properties.length; pi++) {
      const prop = expr.properties[pi]!;
      if (ts.isSpreadAssignment(prop)) {
        const srcFields = spreadByPropIndex.get(pi);
        if (srcFields) for (const f of srcFields) pushName(f.name, false);
        continue;
      }
      if (ts.isMethodDeclaration(prop) || ts.isGetAccessorDeclaration(prop) || ts.isSetAccessorDeclaration(prop)) {
        if (prop.name) pushName(resolveAccessorPropName(ctx, prop.name), true);
        continue;
      }
      pushName(resolvePropertyNameText(ctx, prop), true);
    }
    if (insertionOrder.length > 0) ctx.structInsertionOrder.set(typeName, insertionOrder);
  }

  // (#1557) Per-literal method funcIdx overrides. When struct dedup collapses
  // multiple object literals that share a field shape but have methods with
  // different signatures (e.g. `{ validate(value) {} }` and `{ validate() {} }`
  // both type as `__anon_0` because `validate` resolves to externref with no
  // call signatures), the shared `funcMap` entry `__anon_0_validate` would be
  // overwritten by whichever method body is compiled last — breaking
  // trampolines emitted against the earlier-arity sig. To keep each literal's
  // method body + trampoline self-consistent, when we detect a method here
  // whose `methodFullName` is already bound to a function whose signature
  // differs from the new one, we allocate a fresh funcIdx for THIS literal's
  // method and route both the trampoline AND the body to it via this local
  // map. The shared `funcMap` entry continues to point at the original
  // placeholder (used by external lookups like `ClassName.prototype.method`).
  const literalMethodFuncIdx = new Map<string, number>();
  for (const prop of expr.properties) {
    if (!ts.isMethodDeclaration(prop)) continue;
    if (!prop.name) continue;
    if (
      !ts.isIdentifier(prop.name) &&
      !ts.isStringLiteral(prop.name) &&
      !ts.isNumericLiteral(prop.name) &&
      !ts.isComputedPropertyName(prop.name)
    ) {
      continue;
    }
    const methodName = resolveAccessorPropName(ctx, prop.name);
    if (methodName === undefined) continue;
    const fullName = `${typeName}_${methodName}`;
    const existingFuncIdx = ctx.funcMap.get(fullName);
    // Struct-shape deduplication is intentionally independent of source
    // identity.  Once one literal has compiled a method body, reusing its
    // name-keyed function for a later same-shape literal also reuses the
    // promoted capture globals.  The next literal can therefore run the first
    // body's captures (or observe a null capture slot) even though its method
    // source is different.  A populated existing body proves this is a later
    // literal; fork its method just as we already do for ToPrimitive methods.
    // Empty pre-registered placeholders remain shared for the first literal.
    const existingFunc = existingFuncIdx !== undefined ? definedFuncAt(ctx, existingFuncIdx) : undefined;
    // Binding-pattern methods have a representation-specific destructuring
    // ABI. Reusing a populated method body across same-shaped literals is safe
    // for ordinary positional methods, but the broad fork changes the hidden
    // parameter carrier for array/object patterns and leaves their iterator
    // value in the wrong domain. Keep the existing signature-based fork path
    // for those methods and apply the distinct-literal fork only to positional
    // methods.
    const hasBindingPatternParameter = prop.parameters.some(
      (parameter) => ts.isArrayBindingPattern(parameter.name) || ts.isObjectBindingPattern(parameter.name),
    );
    const forkForDistinctLiteral =
      existingFunc !== undefined && existingFunc.body.length > 0 && !hasBindingPatternParameter;

    // (#1989) ToPrimitive-relevant methods (`valueOf`/`toString`/
    // `@@toPrimitive`) MUST be per-instance when two same-shape object literals
    // deduplicate to the same struct type. Otherwise the shared
    // `${typeName}_valueOf` method (used both as the ToPrimitive fallback AND as
    // the body referenced by the first literal's stored closure) collapses
    // distinct literals onto the LAST-compiled method body — so
    // `{valueOf(){return 7}}` and `{valueOf(){return 100}}` both coerce via
    // `()=>100`. The generic #1557 fork below only fires on a *signature*
    // mismatch; same-signature siblings (the exact #1989 repro) slip past it.
    //
    // We fix this with a per-struct "claim" of the shared method func:
    //   - The FIRST same-shape literal claims the shared `${typeName}_valueOf`
    //     func (binding it in `literalMethodFuncIdx` so its OWN closure points at
    //     it and its body lands in it). The shared func keeps a real body, so the
    //     host `__call_*`/`__sget_*` exports and name-keyed coercion fallbacks
    //     still work.
    //   - Every LATER same-shape literal FORKS a fresh per-literal func (below),
    //     stores its own funcref in the struct field, and the per-instance
    //     `call_ref` dispatch resolves to the right body per object.
    // This claim is independent of WHEN the method func happens to be pre-
    // registered in `funcMap` (it is for `any`-typed structs via the widening
    // pre-pass, but not for nominal struct types) — `existingFuncIdx` is an
    // unreliable "is this the first literal?" signal, so we track the claim
    // explicitly in `ctx.toPrimitiveSharedClaimed`.
    const isToPrimitiveMethod = methodName === "valueOf" || methodName === "toString" || methodName === "@@toPrimitive";
    let forkToPrimitive = false;
    if (isToPrimitiveMethod) {
      if (!ctx.toPrimitiveSharedClaimed.has(fullName)) {
        // First same-shape literal: claim the shared func but leave it ENTIRELY
        // on the base path — do NOT add a `literalMethodFuncIdx` override. The
        // shared `${typeName}_valueOf` func is maintained by `funcMap` and the
        // body loop the same way it is on main; capturing the funcIdx HERE
        // (pre-construction) would record a STALE index, because
        // `emitObjectMethodAsClosure` for an earlier field pushes a trampoline
        // func during construction and shifts later method funcs (a
        // valueOf+toString literal hit exactly this: toString's body landed in
        // the pre-pass index while `funcMap` advanced to a fresh one, leaving the
        // dispatched func empty). The first literal's per-instance closure is
        // stored at construction via `funcMap.get(methodFullName)` for `any`
        // structs (pre-registered) just as on main; nominal single-literal
        // structs keep the name-keyed standalone path. Only LATER same-shape
        // literals need a per-literal fork.
        ctx.toPrimitiveSharedClaimed.add(fullName);
        continue;
      }
      // 2nd+ same-shape literal: always fork a fresh per-literal func so its
      // stored closure carries its own body (the #1989 collision fix).
      forkToPrimitive = true;
    }

    if (existingFuncIdx === undefined && !forkToPrimitive) continue;

    // Compute the signature this method would compile to. This MUST mirror the
    // body-compile param-type derivation below (search "methodParams") exactly,
    // otherwise the fork decision diverges from reality: it would think this
    // single-literal method's params differ from the registered func type and
    // fork a per-literal funcIdx, orphaning the shared `funcMap` entry with an
    // empty stub body — a *direct* call `obj.method()` (dispatched via funcMap,
    // not the per-literal map) then lands on the empty func and traps
    // ("dereferencing a null pointer" / iterator-protocol "reading 'next' of
    // null"). (#1671 — completes #1669/#1602.)
    const newParams: ValType[] = [{ kind: "ref", typeIdx: structTypeIdx }];
    for (const param of prop.parameters) {
      const paramType = ctx.checker.getTypeAtLocation(param);
      let wasmType = resolveWasmType(ctx, paramType);
      if (param.initializer && wasmType.kind === "ref") {
        wasmType = { kind: "ref_null", typeIdx: (wasmType as { kind: "ref"; typeIdx: number }).typeIdx };
      }
      // (#1671) Binding-pattern params route through the externref destructure
      // path during body compilation (#1151 Gap B — see line ~1524). The
      // fork-decision sig must apply the SAME widening, or
      // `async *method([, , ...x] = […]) {}` (array binding pattern) computes
      // `(ref null vec)` here while the real body uses `externref`, a `kind`
      // divergence `refTypesMatch` cannot reconcile, spuriously forking.
      const hasBindingPattern = ts.isArrayBindingPattern(param.name) || ts.isObjectBindingPattern(param.name);
      if (hasBindingPattern && !param.type && !param.dotDotDotToken && wasmType.kind !== "externref") {
        wasmType = { kind: "externref" };
      }
      newParams.push(wasmType);
    }

    // Compare against the existing function's signature. A mismatched param
    // count causes "not enough arguments on the stack" trampoline failures.
    // (#1602) A param-type/order mismatch with the SAME count is just as
    // breaking: two structurally-deduped sibling literals (e.g.
    // `{ *m(x = 42, y) {} }` → params [f64, externref] and
    // `{ *m(x, y = 42) {} }` → params [externref, f64]) share one funcMap
    // entry, so the second body-compile overwrites the func's typeIdx and any
    // method-as-closure trampoline built for the first literal forwards args in
    // the wrong order, emitting an invalid `call`. Treat any per-position type
    // divergence as a mismatch too, so each literal gets its own funcIdx.
    // (#1989) A 2nd+ ToPrimitive-method literal (`forkToPrimitive`) skips the
    // same-signature short-circuit entirely: it must ALWAYS fork a per-literal
    // funcIdx so its stored closure carries its own body, even when its
    // signature matches the first literal's (the exact #1989 same-shape repro).
    // Other methods keep the #1557 behaviour: fork only on a real signature
    // mismatch.
    if (!forkToPrimitive && !forkForDistinctLiteral) {
      // Reaching here with `!forkToPrimitive` guarantees `existingFuncIdx` is
      // defined (the `existingFuncIdx === undefined && !forkToPrimitive`
      // short-circuit above already `continue`d), but TS can't narrow it.
      if (existingFuncIdx === undefined) continue;
      const existingFunc = definedFuncAt(ctx, existingFuncIdx);
      if (!existingFunc) continue;
      const existingType = ctx.mod.types[existingFunc.typeIdx];
      if (!existingType || existingType.kind !== "func") continue;
      const sameArity = existingType.params.length === newParams.length;
      // (#1602 regression fix) Compare param types nullability-insensitively for
      // ref/ref_null of the SAME struct typeIdx. The pre-pass builds the self
      // param as a non-null `ref structTypeIdx`, but the actual compiled method
      // uses `ref null structTypeIdx` for self (and `ref null T` for any
      // default-initialised ref param). A strict `valTypesMatch` flags this as a
      // mismatch and forks a per-literal funcIdx — but that orphans the original
      // shared funcMap entry (left with an empty body), so a *direct* call like
      // `obj.method()` (which dispatches via funcMap, not the per-literal map)
      // lands on the empty func and traps. Real divergence we still want to
      // catch (e.g. sibling literals with [f64, externref] vs [externref, f64])
      // differs in `kind` or `typeIdx`, which `refTypesMatch` still rejects.
      const refTypesMatch = (p: ValType, q: ValType): boolean => {
        const pRef = p.kind === "ref" || p.kind === "ref_null";
        const qRef = q.kind === "ref" || q.kind === "ref_null";
        if (pRef && qRef) {
          return (p as { typeIdx: number }).typeIdx === (q as { typeIdx: number }).typeIdx;
        }
        return valTypesMatch(p, q);
      };
      const sameParamTypes = sameArity && existingType.params.every((p, i) => refTypesMatch(p, newParams[i]!));
      if (sameArity && sameParamTypes) continue;
    }

    // Mismatch (or a forced-per-instance ToPrimitive method) — allocate a fresh
    // funcIdx for this literal's method without touching the shared funcMap entry.
    //
    // (#1602) Seed the fresh func with a type built from THIS literal's actual
    // params (`newParams`) and result, not the colliding sibling's type. A
    // method-as-closure trampoline emitted for this literal reads the func's
    // signature up front (before the body-compile pass refines it); a stale
    // placeholder type would make the trampoline forward args in the wrong
    // order/type and emit an invalid `call`.
    const isGen = prop.asteriskToken !== undefined;
    const methodSig = ctx.checker.getSignatureFromDeclaration(prop);
    let methodResult: ValType[] = [];
    if (isGen) {
      methodResult = [{ kind: "externref" }];
    } else if (methodSig) {
      let rt = ctx.checker.getReturnTypeOfSignature(methodSig);
      const isAsync = prop.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ?? false;
      if (isAsync) rt = unwrapPromiseType(rt, ctx.checker);
      if (rt && !isVoidType(rt)) methodResult = [resolveWasmType(ctx, rt)];
    }
    const freshTypeIdx = addFuncType(ctx, newParams, methodResult, `${fullName}__lit_type`);
    const freshFuncIdx = mintDefinedFunc(ctx);
    pushDefinedFunc(ctx, freshFuncIdx, {
      name: `${fullName}__lit${freshFuncIdx}`,
      typeIdx: freshTypeIdx, // seeded from this literal's params; body-compile may refine
      locals: [],
      body: [],
      exported: false,
    });
    literalMethodFuncIdx.set(methodName, freshFuncIdx);

    if (forkToPrimitive) {
      // (#1989) This is a 2nd+ same-shape literal of a ToPrimitive method — the
      // genuine same-shape collision. Mark the struct so the host `__call_*`
      // dispatch (and the in-module coercion sites) opt into per-instance
      // struct-field closure dispatch. The single-literal case stays on the
      // name-keyed standalone arm, preserving the §7.1.1.1 step-6 TypeError walk.
      ctx.toPrimitiveForkedStructs.add(typeName);
    }
  }

  for (const field of fields) {
    // (#2129) Collect EVERY property that defines this field, in source
    // order. Per §13.2.5.5 PropertyDefinitionEvaluation, each duplicate runs
    // (its initializer's side effects are observable) and the LAST definition
    // provides the field's value — not the first.
    //
    // #2010: resolvePropertyNameText also matches shorthands; classify them
    // separately so the dedicated shorthand branch below (which compiles
    // `prop.name` as the value) keeps handling them.
    // #1118: method shorthand `{ m() {…} }` — resolvePropertyNameText returns
    // undefined for MethodDeclaration, so match those by name explicitly.
    const matchingProps = expr.properties.filter((p) => {
      if (ts.isShorthandPropertyAssignment(p)) return p.name.text === field.name;
      if (ts.isMethodDeclaration(p)) {
        return (
          !!p.name &&
          ((ts.isIdentifier(p.name) && p.name.text === field.name) ||
            (ts.isStringLiteral(p.name) && p.name.text === field.name) ||
            (ts.isNumericLiteral(p.name) && p.name.text === field.name))
        );
      }
      return resolvePropertyNameText(ctx, p) === field.name;
    });
    const lastMatch = matchingProps[matchingProps.length - 1];
    // (#2129) Evaluate earlier duplicates' initializers for their side
    // effects and drop the values. (Shorthands/methods have no side effects
    // to run.) Note: duplicates are evaluated adjacent to the winning one,
    // so cross-key side-effect ORDER may deviate from strict source order in
    // mixed duplicate literals — the same field-order evaluation the struct
    // path already uses.
    for (let di = 0; di < matchingProps.length - 1; di++) {
      const dup = matchingProps[di]!;
      if (ts.isPropertyAssignment(dup)) {
        const dupType = compileExpression(ctx, fctx, dup.initializer);
        if (dupType) fctx.body.push({ op: "drop" });
      }
    }
    // (#2009 R3) Source-order override: when a spread appears AFTER the last
    // named/shorthand/method writer of this key, the spread wins
    // (`{ x:1, ...{x:5} }` → `x:5`). Find the position of the winning named
    // writer and the LAST spread (by source position) that also defines this
    // field; if that spread comes later, take its value instead of the named
    // prop. When there is no named writer this is a no-op (the existing
    // "fall through to spread" path below handles it). The named prop's
    // initializer is still evaluated above for its observable side effects.
    const lastMatchIndex = lastMatch ? expr.properties.indexOf(lastMatch) : -1;
    let overridingSpread:
      | { local: number; srcStructTypeIdx: number; srcFields: { name: string }[]; propIndex: number }
      | undefined;
    for (const src of spreadSources) {
      if (src.propIndex <= lastMatchIndex) continue;
      if (src.srcFields.some((f) => f.name === field.name)) {
        if (!overridingSpread || src.propIndex > overridingSpread.propIndex) {
          overridingSpread = src;
        }
      }
    }
    if (overridingSpread) {
      // (#4616) A spread source can be NULLISH at runtime (`{ a: 1,
      // ...options }` with `options` an optional param — jest's
      // deepCyclicCopy) and §13.2.5.5 CopyDataProperties SKIPS a nullish
      // source. An unguarded `struct.get` trapped un-catchably
      // ("dereferencing a null pointer"). Guard on `ref.is_null`: null →
      // keep the named writer's value (or the field default when the writer
      // has no expressible value); non-null → the spread's field.
      const fieldIdx = overridingSpread.srcFields.findIndex((f) => f.name === field.name);
      const namedTmp = allocTempLocal(fctx, field.type);
      if (lastMatch && ts.isPropertyAssignment(lastMatch)) {
        compileExpression(ctx, fctx, lastMatch.initializer, field.type);
        fctx.body.push({ op: "local.set", index: namedTmp });
      } else if (lastMatch && ts.isShorthandPropertyAssignment(lastMatch)) {
        compileExpression(ctx, fctx, lastMatch.name, field.type);
        fctx.body.push({ op: "local.set", index: namedTmp });
      } else {
        pushStructFieldDefault(ctx, fctx, field.type);
        fctx.body.push({ op: "local.set", index: namedTmp });
      }
      fctx.body.push({ op: "local.get", index: overridingSpread.local });
      fctx.body.push({ op: "ref.is_null" });
      fctx.body.push({
        op: "if",
        blockType: { kind: "val", type: spreadGuardBlockType(field.type) },
        then: [{ op: "local.get", index: namedTmp }],
        else: spreadFieldReadWithAbsentFallback(ctx, fctx, overridingSpread, fieldIdx, field.type, [
          { op: "local.get", index: namedTmp },
        ]),
      });
      releaseTempLocal(fctx, namedTmp);
      continue;
    }
    const prop =
      lastMatch && !ts.isShorthandPropertyAssignment(lastMatch) && !ts.isMethodDeclaration(lastMatch)
        ? lastMatch
        : undefined;
    const shorthandProp = lastMatch && ts.isShorthandPropertyAssignment(lastMatch) ? lastMatch : undefined;
    const methodProp = lastMatch && ts.isMethodDeclaration(lastMatch) ? lastMatch : undefined;
    if (methodProp) {
      const methodFullName = `${typeName}_${field.name}`;
      // (#1557) Prefer the per-literal funcIdx if we detected a sig mismatch
      // above. The trampoline must reference the funcIdx whose body will
      // actually be compiled for THIS literal, not a sibling literal's body.
      const methodFuncIdx = literalMethodFuncIdx.get(field.name) ?? ctx.funcMap.get(methodFullName);
      if (methodFuncIdx !== undefined) {
        // (#4440) `methodProp` is the object-literal member itself — pass it so
        // the closure carries §15.1.5 `length` / §10.2.9 `name` metadata.
        const closureType = emitObjectMethodAsClosure(
          ctx,
          fctx,
          methodFullName,
          methodFuncIdx,
          structTypeIdx,
          methodProp,
        );
        if (closureType) {
          // (#1989) Method-shorthand `valueOf`/`toString` now store a
          // per-instance closure in the eqref field (each literal owns a
          // distinct funcIdx via the per-literal fork above). Register the
          // closure type so ToPrimitive coercion takes the per-instance
          // eqref-closure dispatch (type-coercion.ts) — `struct.get` the
          // closure field of THIS instance and `call_ref` its own funcref —
          // instead of the name-keyed `${typeName}_valueOf` standalone
          // fallback that collapses same-shape literals onto one body.
          if (
            (field.name === "valueOf" || field.name === "toString") &&
            field.type.kind === "eqref" &&
            (closureType.kind === "ref" || closureType.kind === "ref_null")
          ) {
            const closureTypeIdx = (closureType as { typeIdx: number }).typeIdx;
            const existing = ctx.valueOfClosureTypes.get(typeName) ?? [];
            if (!existing.includes(closureTypeIdx)) {
              existing.push(closureTypeIdx);
              ctx.valueOfClosureTypes.set(typeName, existing);
            }
          }
          // Coerce closure-struct ref → field type. The common case is
          // externref (un-typed obj literal), which needs extern.convert_any.
          // For a concretely-typed struct field of the same closure type,
          // no coercion is needed.
          if (field.type.kind === "externref") {
            fctx.body.push({ op: "extern.convert_any" });
          } else if (field.type.kind === "eqref") {
            // ref → eqref: GC ref subtype, no instruction needed (implicit).
          } else if (
            (field.type.kind === "ref" || field.type.kind === "ref_null") &&
            (field.type as { typeIdx: number }).typeIdx !== (closureType as { typeIdx: number }).typeIdx
          ) {
            // Mismatched ref types — fall back to the default branch by
            // dropping our closure and re-emitting undefined below. This
            // shouldn't happen for well-formed fields but keeps codegen
            // sound under TypeChecker quirks.
            fctx.body.push({ op: "drop" });
            fctx.body.push({ op: "ref.null", typeIdx: (field.type as { typeIdx: number }).typeIdx });
          }
          continue; // field handled
        }
      }
      // Fall through to the default-undefined branch if the closure
      // emission failed (e.g. unsupported signature). Better to leave
      // the field undefined than to leave the stack unbalanced.
      if (field.type.kind === "externref") emitUndefined(ctx, fctx);
      else if (field.type.kind === "eqref") fctx.body.push({ op: "ref.null.eq" });
      else if (field.type.kind === "ref" || field.type.kind === "ref_null")
        fctx.body.push({ op: "ref.null", typeIdx: field.type.typeIdx });
      else fctx.body.push({ op: "i32.const", value: 0 });
      continue;
    }
    if (prop && ts.isPropertyAssignment(prop)) {
      // Track closure types for valueOf/toString fields
      const bodyLenBefore = fctx.body.length;
      const hostFieldValue = mayHaveModuleHostSpreadField && isModuleGlobalHostSpreadIdentifier(ctx, prop.initializer);
      if (!hostFieldValue || compileHostObjectAsStruct(ctx, fctx, prop.initializer, field.type) === null) {
        compileExpression(ctx, fctx, prop.initializer, field.type);
      }
      trackToPrimitiveClosureTypes(ctx, fctx, typeName, field, bodyLenBefore);
    } else if (shorthandProp && ts.isShorthandPropertyAssignment(shorthandProp)) {
      // Shorthand { x } means the value is the identifier x — compile it.
      // (#4394) Track valueOf/toString closure types here too: the deepEqual.js
      // harness stores its lazy toString as `return { toString };`, and an
      // untracked eqref field left the per-instance `__call_toString` dispatch
      // with zero candidates — ToPrimitive fell to "[object Object]".
      const bodyLenBefore = fctx.body.length;
      compileExpression(ctx, fctx, shorthandProp.name, field.type);
      trackToPrimitiveClosureTypes(ctx, fctx, typeName, field, bodyLenBefore);
    } else {
      // Check spread sources (last spread wins — JS semantics).
      // (#4616) Each spread source can be NULLISH at runtime and §13.2.5.5
      // CopyDataProperties skips a nullish source, so build the chain as
      // nested runtime guards: last non-null source that has the field wins;
      // all-null (or no source has it) falls to the default sentinel.
      const defaultInstrs: Instr[] = [];
      {
        // Default value for missing fields: use "undefined" sentinels so
        // destructuring default-value checks can detect missing properties.
        // f64 uses sNaN sentinel 0x7FF00000DEADC0DE (matches emitDefaultValueCheck #866).
        // externref uses JS undefined (via __get_undefined) not ref.null.extern,
        // because JS destructuring defaults fire only on `=== undefined`, not null.
        const saved = fctx.body;
        fctx.body = defaultInstrs;
        pushStructFieldDefault(ctx, fctx, field.type);
        fctx.body = saved;
      }
      let chain: Instr[] = defaultInstrs;
      for (let si = 0; si < spreadSources.length; si++) {
        const src = spreadSources[si]!;
        const fieldIdx = src.srcFields.findIndex((f) => f.name === field.name);
        if (fieldIdx < 0) continue;
        chain = [
          { op: "local.get", index: src.local },
          { op: "ref.is_null" },
          {
            op: "if",
            blockType: { kind: "val", type: spreadGuardBlockType(field.type) },
            then: chain,
            // structuredClone: the fallback re-embeds the inner chain, and the
            // late-import shifter must never see the SAME instr object through
            // two parent arrays (it would double-shift its funcIdx).
            else: spreadFieldReadWithAbsentFallback(ctx, fctx, src, fieldIdx, field.type, structuredClone(chain)),
          },
        ];
      }
      fctx.body.push(...chain);
    }
  }

  fctx.body.push({ op: "struct.new", typeIdx: structTypeIdx });

  // Register and compile getter/setter accessors on the object literal
  for (const prop of expr.properties) {
    if (
      ts.isGetAccessorDeclaration(prop) &&
      prop.name &&
      (ts.isIdentifier(prop.name) ||
        ts.isStringLiteral(prop.name) ||
        ts.isComputedPropertyName(prop.name) ||
        ts.isNumericLiteral(prop.name))
    ) {
      const propName = resolveAccessorPropName(ctx, prop.name);
      if (propName === undefined) continue;
      const accessorKey = `${typeName}_${propName}`;
      ctx.classAccessorSet.add(accessorKey);

      // (#1888 S5c / C5) Object-literal `{ get x() {} }` STORE arm — land dark
      // behind `S5C_STRUCT_ACCESSOR_CLOSURE`. Mirror the C2 define-site: lift the
      // getter as a host-free closure (captures baked into `$self`) and store it
      // in the per-(struct,prop) global so the C3 read site routes through the
      // shared __call_accessor_get driver. `fctx` here is the ENCLOSING function
      // (the object literal is built inline), so `compileArrowAsClosure`
      // correctly captures the outer scope. The bare-fn getter below still
      // compiles (harmless); the read site prefers the closure when the global
      // exists. Additive + side-effect-free when the flag is off.
      // (#1888 S5c / C5) Object-literal `{ get x() {} }` STORE arm. Lift the
      // getter as a host-free closure (captures baked into `$self`) and store it
      // in the per-(struct,prop) global so the C3 read site routes through the
      // shared __call_accessor_get driver. `fctx` here is the ENCLOSING function
      // (the object literal is built inline), so `compileArrowAsClosure` captures
      // the outer scope correctly. ADDITIVE: the bare `${struct}_get_${prop}` fn
      // below still compiles so the objlit struct shape stays valid (downstream
      // struct construction references its funcIdx); the read site just prefers
      // the closure when the global exists. Side-effect-free when the flag is off.
      // (NOTE: the objlit-standalone bare-fn path has a SEPARATE pre-existing
      // "u32 out of range: -1" serialization defect via
      // `promoteAccessorCapturesToGlobals` — out of scope for the S5c closure
      // rework; tracked by the still-RED objlit test.)
      if (S5C_STRUCT_ACCESSOR_CLOSURE && ctx.standalone) {
        const getGlobalIdx = ensureStructAccessorGlobal(ctx, typeName, propName, "get");
        if (buildAccessorClosure(ctx, fctx, prop as unknown as ts.FunctionExpression)) {
          fctx.body.push({ op: "global.set", index: getGlobalIdx });
        } else {
          fctx.body.push({ op: "ref.null.extern" });
          fctx.body.push({ op: "global.set", index: getGlobalIdx });
          ctx.structAccessorClosure.get(`${typeName}_${propName}`)!.getGlobal = undefined;
        }
      }

      const getterName = `${typeName}_get_${propName}`;
      const getterParams: ValType[] = [{ kind: "ref", typeIdx: structTypeIdx }];
      const sig = ctx.checker.getSignatureFromDeclaration(prop);
      let getterResults: ValType[] = [];
      if (sig) {
        const retType = ctx.checker.getReturnTypeOfSignature(sig);
        if (!isVoidType(retType)) {
          getterResults = [resolveWasmType(ctx, retType)];
        }
      }

      const getterTypeIdx = addFuncType(ctx, getterParams, getterResults, `${getterName}_type`);
      const getterFuncIdx = mintDefinedFunc(ctx);
      ctx.funcMap.set(getterName, getterFuncIdx);

      const getterFunc: WasmFunction = {
        name: getterName,
        typeIdx: getterTypeIdx,
        locals: [],
        body: [],
        exported: false,
      };
      pushDefinedFunc(ctx, getterFuncIdx, getterFunc);

      // Promote captured locals to globals so the getter body can access them
      promoteAccessorCapturesToGlobals(ctx, fctx, prop.body);

      // Compile getter body
      const getterFctx: FunctionContext = {
        name: getterName,
        params: [{ name: "this", type: { kind: "ref", typeIdx: structTypeIdx } }],
        locals: [],
        localMap: new Map(),
        returnType: getterResults.length > 0 ? getterResults[0]! : null,
        body: [],
        blockDepth: 0,
        breakStack: [],
        continueStack: [],
        labelMap: new Map(),
        savedBodies: [],
      };
      initializeFunctionPoisonPillContext(ctx, getterFctx, prop);
      getterFctx.localMap.set("this", 0);

      const savedFunc = ctx.currentFunc;
      if (savedFunc) ctx.parentBodiesStack.push(savedFunc.body);
      if (savedFunc) ctx.funcStack.push(savedFunc);
      ctx.currentFunc = getterFctx;
      if (prop.body) {
        for (const stmt of prop.body.statements) {
          compileStatement(ctx, getterFctx, stmt);
        }
      }
      // Ensure valid return for non-void getters
      if (getterFctx.returnType) {
        const lastInstr = getterFctx.body[getterFctx.body.length - 1];
        if (!lastInstr || lastInstr.op !== "return") {
          if (getterFctx.returnType.kind === "f64") {
            getterFctx.body.push({ op: "f64.const", value: 0 });
          } else if (getterFctx.returnType.kind === "i32") {
            getterFctx.body.push({ op: "i32.const", value: 0 });
          } else if (getterFctx.returnType.kind === "externref") {
            getterFctx.body.push({ op: "ref.null.extern" });
          } else if (getterFctx.returnType.kind === "ref" || getterFctx.returnType.kind === "ref_null") {
            getterFctx.body.push({ op: "ref.null", typeIdx: getterFctx.returnType.typeIdx });
          }
        }
      }
      cacheStringLiterals(ctx, getterFctx);
      getterFunc.locals = getterFctx.locals;
      getterFunc.body = getterFctx.body;
      if (savedFunc) ctx.funcStack.pop();
      if (savedFunc) ctx.parentBodiesStack.pop();
      ctx.currentFunc = savedFunc;
    }

    if (
      ts.isSetAccessorDeclaration(prop) &&
      prop.name &&
      (ts.isIdentifier(prop.name) ||
        ts.isStringLiteral(prop.name) ||
        ts.isComputedPropertyName(prop.name) ||
        ts.isNumericLiteral(prop.name))
    ) {
      const propName = resolveAccessorPropName(ctx, prop.name);
      if (propName === undefined) continue;
      const accessorKey = `${typeName}_${propName}`;
      ctx.classAccessorSet.add(accessorKey);

      // (#1888 S5c / C5) Object-literal setter STORE arm — see the getter arm
      // above. Lift the setter closure and store it in the per-(struct,prop)
      // set-slot so the C4 write site routes through __call_accessor_set.
      // ADDITIVE: the bare `${struct}_set_${prop}` fn below still compiles to keep
      // the objlit struct shape valid.
      if (S5C_STRUCT_ACCESSOR_CLOSURE && ctx.standalone) {
        const setGlobalIdx = ensureStructAccessorGlobal(ctx, typeName, propName, "set");
        if (buildAccessorClosure(ctx, fctx, prop as unknown as ts.FunctionExpression)) {
          fctx.body.push({ op: "global.set", index: setGlobalIdx });
        } else {
          fctx.body.push({ op: "ref.null.extern" });
          fctx.body.push({ op: "global.set", index: setGlobalIdx });
          ctx.structAccessorClosure.get(`${typeName}_${propName}`)!.setGlobal = undefined;
        }
      }

      const setterName = `${typeName}_set_${propName}`;
      const setterParams: ValType[] = [{ kind: "ref", typeIdx: structTypeIdx }];
      for (const param of prop.parameters) {
        const paramType = ctx.checker.getTypeAtLocation(param);
        setterParams.push(resolveWasmType(ctx, paramType));
      }

      const setterTypeIdx = addFuncType(ctx, setterParams, [], `${setterName}_type`);
      const setterFuncIdx = mintDefinedFunc(ctx);
      ctx.funcMap.set(setterName, setterFuncIdx);

      const setterFunc: WasmFunction = {
        name: setterName,
        typeIdx: setterTypeIdx,
        locals: [],
        body: [],
        exported: false,
      };
      pushDefinedFunc(ctx, setterFuncIdx, setterFunc);

      // Promote captured locals to globals so the setter body can access them
      promoteAccessorCapturesToGlobals(ctx, fctx, prop.body);

      // Compile setter body
      const setterFctxParams: { name: string; type: ValType }[] = [
        { name: "this", type: { kind: "ref", typeIdx: structTypeIdx } },
      ];
      for (let pi = 0; pi < prop.parameters.length; pi++) {
        const param = prop.parameters[pi]!;
        const paramName = ts.isIdentifier(param.name) ? param.name.text : `__param${pi}`;
        const paramType = ctx.checker.getTypeAtLocation(param);
        setterFctxParams.push({ name: paramName, type: resolveWasmType(ctx, paramType) });
      }

      const setterFctx: FunctionContext = {
        name: setterName,
        params: setterFctxParams,
        locals: [],
        localMap: new Map(),
        returnType: null,
        body: [],
        blockDepth: 0,
        breakStack: [],
        continueStack: [],
        labelMap: new Map(),
        savedBodies: [],
      };
      initializeFunctionPoisonPillContext(ctx, setterFctx, prop);
      for (let i = 0; i < setterFctxParams.length; i++) {
        setterFctx.localMap.set(setterFctxParams[i]!.name, i);
      }

      const savedFunc = ctx.currentFunc;
      if (savedFunc) ctx.parentBodiesStack.push(savedFunc.body);
      if (savedFunc) ctx.funcStack.push(savedFunc);
      ctx.currentFunc = setterFctx;

      // Emit default-value initialization for setter parameters with initializers (#377)
      for (let pi = 0; pi < prop.parameters.length; pi++) {
        const param = prop.parameters[pi]!;
        if (!param.initializer) continue;

        const paramLocalIdx = pi + 1; // account for 'this' param
        const paramType = setterFctxParams[paramLocalIdx]!.type;

        // Build the "then" block: compile default expression, local.set
        const savedBody = pushBody(setterFctx);
        compileExpression(ctx, setterFctx, param.initializer, paramType);
        setterFctx.body.push({ op: "local.set", index: paramLocalIdx });
        const thenInstrs = setterFctx.body;
        popBody(setterFctx, savedBody);

        // Emit the null/zero check + conditional assignment
        if (paramType.kind === "externref") {
          setterFctx.body.push({ op: "local.get", index: paramLocalIdx });
          setterFctx.body.push({ op: "ref.is_null" });
          setterFctx.body.push({ op: "if", blockType: { kind: "empty" }, then: thenInstrs });
        } else if (paramType.kind === "ref_null" || paramType.kind === "ref") {
          setterFctx.body.push({ op: "local.get", index: paramLocalIdx });
          setterFctx.body.push({ op: "ref.is_null" });
          setterFctx.body.push({ op: "if", blockType: { kind: "empty" }, then: thenInstrs });
        } else if (paramType.kind === "i32") {
          setterFctx.body.push({ op: "local.get", index: paramLocalIdx });
          setterFctx.body.push({ op: "i32.eqz" });
          setterFctx.body.push({ op: "if", blockType: { kind: "empty" }, then: thenInstrs });
        } else if (paramType.kind === "f64") {
          setterFctx.body.push({ op: "local.get", index: paramLocalIdx });
          setterFctx.body.push({ op: "f64.const", value: 0 });
          setterFctx.body.push({ op: "f64.eq" });
          setterFctx.body.push({ op: "if", blockType: { kind: "empty" }, then: thenInstrs });
        }
      }

      if (prop.body) {
        for (const stmt of prop.body.statements) {
          compileStatement(ctx, setterFctx, stmt);
        }
      }
      cacheStringLiterals(ctx, setterFctx);
      setterFunc.locals = setterFctx.locals;
      setterFunc.body = setterFctx.body;
      if (savedFunc) ctx.funcStack.pop();
      if (savedFunc) ctx.parentBodiesStack.pop();
      ctx.currentFunc = savedFunc;
    }

    // Object literal methods: { method() { ... } }, { "method"() { ... } }, { [key]() { ... } }
    if (
      ts.isMethodDeclaration(prop) &&
      prop.name &&
      (ts.isIdentifier(prop.name) ||
        ts.isStringLiteral(prop.name) ||
        ts.isNumericLiteral(prop.name) ||
        ts.isComputedPropertyName(prop.name))
    ) {
      const methodName = resolveAccessorPropName(ctx, prop.name);
      if (methodName === undefined) continue;
      const fullName = `${typeName}_${methodName}`;
      ctx.classMethodSet.add(fullName);

      // Check if this is a generator method (*method() { ... })
      const isGeneratorMethod = prop.asteriskToken !== undefined;
      if (isGeneratorMethod) {
        ctx.generatorFunctions.add(fullName);
      }

      const methodParams: ValType[] = [{ kind: "ref", typeIdx: structTypeIdx }];
      for (const param of prop.parameters) {
        const paramType = ctx.checker.getTypeAtLocation(param);
        let wasmType = resolveWasmType(ctx, paramType);
        // If the parameter has a default value and is a non-null ref type,
        // widen to ref_null so callers can pass ref.null as a sentinel for "use default"
        if (param.initializer && wasmType.kind === "ref") {
          wasmType = { kind: "ref_null", typeIdx: (wasmType as { kind: "ref"; typeIdx: number }).typeIdx };
        }
        // Binding-pattern params MUST route through the externref destructure path
        // so that (a) null/undefined trigger a spec-mandated synchronous TypeError and
        // (b) nested patterns recurse via the generic destructure logic. See #1151
        // Gap B — mirrors closures.ts:1186 and class-bodies.ts:1160.
        const hasBindingPattern = ts.isArrayBindingPattern(param.name) || ts.isObjectBindingPattern(param.name);
        if (hasBindingPattern && !param.type && !param.dotDotDotToken && wasmType.kind !== "externref") {
          wasmType = { kind: "externref" };
        }
        methodParams.push(wasmType);
      }

      const sig = ctx.checker.getSignatureFromDeclaration(prop);
      // For async methods, unwrap Promise<T> to get T (matching top-level handling)
      // Exclude async generators: they return AsyncGenerator objects, not Promises.
      const isAsyncMethod = prop.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ?? false;
      if (isAsyncMethod && !isGeneratorMethod) {
        ctx.asyncFunctions.add(fullName);
      }
      let retType = sig ? ctx.checker.getReturnTypeOfSignature(sig) : undefined;
      if (isAsyncMethod && retType) {
        retType = unwrapPromiseType(retType, ctx.checker);
      }
      // (#2581) In a no-JS-host target, a native-capable object-literal
      // generator method returns its `$GenState_*` struct (the lazy native state
      // machine), NOT the eager-buffer externref Generator object. Register it
      // here so the state-struct type exists and the method's wasm signature
      // carries the right result type (mirrors class-bodies.ts #2571 + the
      // free-function path declarations.ts:2499). `methodParams` already leads
      // with the receiver `this` (`ref structTypeIdx`), so pass it through with
      // `synthesizedThis = true` to mint `param_this`. The factory emit is routed
      // in the generator-method body block below. JS-host mode keeps the
      // externref Generator object (eager-buffer) — byte-identical.
      let objMethNativeGen = null;
      if (
        isGeneratorMethod &&
        (ctx.standalone || ctx.wasi) &&
        !isAsyncMethod &&
        isNativeGeneratorCandidate(ctx, prop)
      ) {
        // (#2581) Key the native generator by the SAME identity the method body
        // func gets, so sibling object literals that share `fullName` but own a
        // per-literal funcIdx (different bodies → `literalMethodFuncIdx` fork,
        // #1557) each register a DISTINCT `$GenState` and `.m()` dispatches to
        // its own state machine. Without the per-literal key, the idempotent
        // `registerNativeGenerator` returns the FIRST literal's state for every
        // sibling, so `b.m()` runs `a`'s body (`{*m(){yield 1}}`,`{*m(){yield 2}}`
        // both yielded 1). A forked literal's body compiles into
        // `${fullName}__lit${perLiteralIdx}` (see below); mirror that name here.
        const perLiteralForkIdx = literalMethodFuncIdx.get(methodName);
        const genKey = perLiteralForkIdx !== undefined ? `${fullName}__lit${perLiteralForkIdx}` : fullName;
        objMethNativeGen = registerNativeGenerator(ctx, prop, genKey, methodParams, /* synthesizedThis */ true);
      }
      const methodResults: ValType[] = isGeneratorMethod
        ? objMethNativeGen
          ? [{ kind: "ref", typeIdx: objMethNativeGen.stateTypeIdx }]
          : [{ kind: "externref" }]
        : retType && !isVoidType(retType)
          ? [resolveWasmType(ctx, retType)]
          : [];

      // Track object-literal methods that read `arguments` (#1053) so
      // callers can populate the __extras_argv global with runtime args
      // beyond the formal param count.
      if (needsImplicitArgumentsObject(prop)) {
        ctx.funcUsesArguments.add(fullName);
      }

      // (#3948) Register optional/defaulted params for this object-literal
      // method. Class bodies have always done this (class-bodies.ts
      // `registerClassOptionalParams`), free functions too (declarations.ts);
      // object literals were the one method form that never did — and
      // `maybeSetArgcForKnownCall` is gated on exactly this map, so every
      // `o.m()` call site silently skipped its `global.set $__argc`. The
      // callee's param-default prologue then read the `-1` "unknown caller"
      // sentinel, concluded no argument was missing, and used the raw
      // (zero/null) incoming slot: `{ m(a = 5) }.m()` evaluated to 0 in BOTH
      // lanes. `methodParams` leads with the receiver `this`, so the ValType
      // for source parameter `i` is at `methodParams[i + 1]` — the same
      // `paramTypeOffset = 1` the class path uses for instance methods.
      const objMethodOptionalParams: OptionalParamInfo[] = [];
      for (let pi = 0; pi < prop.parameters.length; pi++) {
        const param = prop.parameters[pi]!;
        if (!param.questionToken && !param.initializer) continue;
        const paramValType = methodParams[pi + 1];
        if (!paramValType) continue;
        const info: OptionalParamInfo = { index: pi, type: paramValType };
        if (param.initializer) {
          const cd = extractConstantDefault(param.initializer, paramValType, ctx);
          if (cd) info.constantDefault = cd;
          else info.hasExpressionDefault = true;
        }
        objMethodOptionalParams.push(info);
      }
      if (objMethodOptionalParams.length > 0) {
        ctx.funcOptionalParams.set(fullName, objMethodOptionalParams);
      }

      const methodTypeIdx = addFuncType(ctx, methodParams, methodResults, `${fullName}_type`);

      // (#1557) If this method was earmarked for a per-literal funcIdx (because
      // a sibling literal sharing the same struct dedup-key already owns the
      // shared `funcMap` entry with a different signature), compile into the
      // dedicated funcIdx instead of overwriting the shared one.
      const perLiteralIdx = literalMethodFuncIdx.get(methodName);
      const existingFuncIdx = perLiteralIdx ?? ctx.funcMap.get(fullName);
      // The shared `funcMap` entry can become stale when sibling object
      // literals share a struct dedup-key (so they share `fullName`) but the
      // earlier-recorded funcIdx points into the import range or past the
      // current functions array — e.g. after late imports shifted indices or
      // a prior literal's function was dropped. Resolving the slot blindly
      // then crashed on `undefined.typeIdx` (#1608). Treat an unresolvable
      // slot as "no existing function" and synthesize a fresh one.
      const existingFunc = existingFuncIdx !== undefined ? definedFuncAt(ctx, existingFuncIdx) : undefined;
      let methodFunc: WasmFunction;
      if (existingFunc !== undefined) {
        methodFunc = existingFunc;
        // Update type in case it was refined
        methodFunc.typeIdx = methodTypeIdx;
      } else {
        const methodFuncIdx = mintDefinedFunc(ctx);
        ctx.funcMap.set(fullName, methodFuncIdx);
        methodFunc = {
          name: fullName,
          typeIdx: methodTypeIdx,
          locals: [],
          body: [],
          exported: false,
        };
        pushDefinedFunc(ctx, methodFuncIdx, methodFunc);
      }

      // Promote captured locals to globals so the method body can access them.
      // (#3040) ALSO scan the parameter-default initializers — an object-literal
      // method like `{ method([x] = iter) {} }` references the enclosing local
      // `iter` ONLY from the default, which the body-only scan misses, so `iter`
      // reads null and the array-destructure throws "Cannot destructure null".
      // The class-method / getter-setter paths already pass these `extraNodes`
      // (#1161, nested-declarations.ts:128-133); mirror it here for plain object
      // methods (the object-method variants of the `ary-init-iter-close` cluster).
      const objMethodParamInits = prop.parameters.map((p) => p.initializer).filter((e): e is ts.Expression => !!e);
      promoteAccessorCapturesToGlobals(ctx, fctx, prop.body, objMethodParamInits);

      // Compile method body
      const methodFctxParams: { name: string; type: ValType }[] = [
        { name: "this", type: { kind: "ref", typeIdx: structTypeIdx } },
      ];
      for (let pi = 0; pi < prop.parameters.length; pi++) {
        const param = prop.parameters[pi]!;
        const paramName = ts.isIdentifier(param.name) ? param.name.text : `__param${pi}`;
        const paramType = ctx.checker.getTypeAtLocation(param);
        let wasmType = resolveWasmType(ctx, paramType);
        // Widen ref to ref_null for params with defaults or optional params
        // to match the function signature (which uses ref_null so callers can pass ref.null)
        if ((param.initializer || param.questionToken) && wasmType.kind === "ref") {
          wasmType = { kind: "ref_null", typeIdx: (wasmType as { kind: "ref"; typeIdx: number }).typeIdx };
        }
        // Binding-pattern params MUST route through the externref destructure path
        // (#1151 Gap B). Must mirror the sig-collection phase above so the fctx
        // param type agrees with the function signature.
        const hasBindingPattern = ts.isArrayBindingPattern(param.name) || ts.isObjectBindingPattern(param.name);
        if (hasBindingPattern && !param.type && !param.dotDotDotToken && wasmType.kind !== "externref") {
          wasmType = { kind: "externref" };
        }
        methodFctxParams.push({ name: paramName, type: wasmType });
      }

      const methodFctx: FunctionContext = {
        name: fullName,
        params: methodFctxParams,
        locals: [],
        localMap: new Map(),
        returnType: methodResults.length > 0 ? methodResults[0]! : null,
        body: [],
        blockDepth: 0,
        breakStack: [],
        continueStack: [],
        labelMap: new Map(),
        savedBodies: [],
        isGenerator: isGeneratorMethod,
      };
      initializeFunctionPoisonPillContext(ctx, methodFctx, prop);
      for (let i = 0; i < methodFctxParams.length; i++) {
        methodFctx.localMap.set(methodFctxParams[i]!.name, i);
      }

      const savedFunc = ctx.currentFunc;
      if (savedFunc) ctx.parentBodiesStack.push(savedFunc.body);
      if (savedFunc) ctx.funcStack.push(savedFunc);
      ctx.currentFunc = methodFctx;

      // Emit default-value initialization for parameters with initializers
      emitMethodParamDefaults(ctx, methodFctx, prop.parameters, 1); // 1 to skip 'this'

      // Destructure parameters with binding patterns (e.g. method([...x]) or method({a, b}))
      for (let pi = 0; pi < prop.parameters.length; pi++) {
        const param = prop.parameters[pi]!;
        const paramLocalIdx = pi + 1; // +1 to skip 'this'
        if (ts.isObjectBindingPattern(param.name)) {
          destructureParamObject(ctx, methodFctx, paramLocalIdx, param.name, methodFctxParams[paramLocalIdx]!.type);
        } else if (ts.isArrayBindingPattern(param.name)) {
          destructureParamArray(ctx, methodFctx, paramLocalIdx, param.name, methodFctxParams[paramLocalIdx]!.type);
        }
      }

      // Set up `arguments` object if the method body references it (#820).
      // Object literal methods need an arguments vec struct so that
      // `arguments.length` and `arguments[n]` work at runtime.
      if (needsImplicitArgumentsObject(prop)) {
        const methodParamTypes = methodFctxParams.slice(1).map((p) => p.type); // skip 'this'
        // Object-literal methods inherit the surrounding code's strictness (#779e).
        // (#2743) Also unmapped when the parameter list is non-simple
        // (rest/default/destructuring) — §10.2.11 step 22.a.
        const unmapped =
          isStrictFunction(prop, ctx.inferModuleStrictArguments) || !isSimpleParameterList(prop.parameters);
        emitArgumentsObject(ctx, methodFctx, methodParamTypes, 1, unmapped); // paramOffset 1 to skip 'this'
      }

      if (isGeneratorMethod && prop.body && objMethNativeGen) {
        // (#2581) Native lazy object-literal generator method: emit the
        // state-struct factory (pushes the `$GenState_*` ref) instead of the
        // eager host buffer. The method body func's param 0 is the receiver
        // `this` (`ref structTypeIdx`), threaded as `param_this` (#2571). The
        // `.next()/.return()/.throw()` dispatch on the returned ref is already
        // representation-agnostic. No host imports — instantiates standalone.
        compileNativeGeneratorFunction(ctx, methodFctx, prop, objMethNativeGen);
        methodFctx.body.push({ op: "return" });
      } else if (
        isGeneratorMethod &&
        isAsyncMethod &&
        prop.body &&
        // (#3132 S2) Bounded async-generator OBJECT-LITERAL METHOD drive —
        // same interception as class-bodies.ts. The receiver is the synthetic
        // param 0 (`this`, typed `ref structTypeIdx`), captured into the
        // `$AsyncFrame` as a param field and restored BY NAME into the resume
        // fn's localMap, so a `this`-reading body resolves it exactly as the
        // entry body does. Still legacy (correct-or-legacy): `super`
        // (home-object binding not threaded) and `arguments` (entry-fn vec
        // struct). `isAsyncGenDriveCandidate` self-limits to standalone/wasi
        // and enforces the bounded body + stem-collision rules — a sibling
        // literal sharing the method name collides on the stem and keeps the
        // legacy buffer below.
        !genBodyReferencesSuper(prop.body) &&
        !bodyNeedsArgumentsObject(prop.body) &&
        isAsyncGenDriveCandidate(ctx, prop)
      ) {
        emitAsyncGenerator(ctx, methodFctx, prop);
        methodFctx.body.push({ op: "return" });
      } else if (isGeneratorMethod && prop.body) {
        // Generator method: eagerly evaluate body, collect yields into a buffer,
        // then wrap with __create_generator to return a Generator-like object.
        // Body is wrapped in try/catch to defer thrown exceptions to first next() (#928).
        const bufferLocal = allocLocal(methodFctx, "__gen_buffer", { kind: "externref" });
        const pendingThrowLocal = allocLocal(methodFctx, "__gen_pending_throw", { kind: "externref" });
        const createBufIdx = ctx.funcMap.get("__gen_create_buffer")!;
        methodFctx.body.push({ op: "call", funcIdx: createBufIdx });
        methodFctx.body.push({ op: "local.set", index: bufferLocal });
        methodFctx.body.push({ op: "ref.null.extern" });
        methodFctx.body.push({ op: "local.set", index: pendingThrowLocal });

        const bodyInstrs: Instr[] = [];
        const outerBody = methodFctx.body;
        methodFctx.body = bodyInstrs;

        methodFctx.generatorReturnDepth = 0;
        methodFctx.blockDepth++;
        for (let i = 0; i < methodFctx.breakStack.length; i++) methodFctx.breakStack[i]!++;
        for (let i = 0; i < methodFctx.continueStack.length; i++) methodFctx.continueStack[i]!++;

        for (const stmt of prop.body.statements) {
          compileStatement(ctx, methodFctx, stmt);
        }

        methodFctx.blockDepth--;
        for (let i = 0; i < methodFctx.breakStack.length; i++) methodFctx.breakStack[i]!--;
        for (let i = 0; i < methodFctx.continueStack.length; i++) methodFctx.continueStack[i]!--;
        methodFctx.generatorReturnDepth = undefined;

        methodFctx.body = outerBody;

        // Wrap generator body block in try/catch to capture exceptions as pending throw
        const tagIdx = ensureExnTag(ctx);
        const getCaughtIdx = ctx.funcMap.get("__get_caught_exception");
        const catchBody: Instr[] = [{ op: "local.set", index: pendingThrowLocal }];
        const catchAllBody: Instr[] =
          getCaughtIdx !== undefined
            ? [
                { op: "call", funcIdx: getCaughtIdx },
                { op: "local.set", index: pendingThrowLocal },
              ]
            : [];
        methodFctx.body.push(
          buildTargetTaggedTry(
            ctx,
            { kind: "empty" },
            [{ op: "block", blockType: { kind: "empty" }, body: bodyInstrs }],
            [{ tagIdx, body: catchBody }],
            catchAllBody.length > 0 ? catchAllBody : undefined,
          ),
        );

        // Return __create_generator or __create_async_generator depending on async flag
        const createGenName = isAsyncMethod ? "__create_async_generator" : "__create_generator";
        // (#2865) Record legacy-buffer async gens so the .next() dispatch keeps a host miss arm.
        if (createGenName === "__create_async_generator") ctx.asyncGenLegacyBufferEmitted = true;
        ctx.legacyGenBufferEmitted = true; // (#3132) sync OR async legacy buffer emitted
        const createGenIdx = ctx.funcMap.get(createGenName)!;
        methodFctx.body.push({ op: "local.get", index: bufferLocal });
        methodFctx.body.push({ op: "local.get", index: pendingThrowLocal });
        methodFctx.body.push({ op: "call", funcIdx: createGenIdx });
      } else if (prop.body) {
        // (#4616) Hoist pre-pass, mirroring the function-body/closure lanes: a
        // nested `function spy()` self-referencing as a value inside a struct-
        // lowered object-literal METHOD (jest's `vi.fn`) needs the stable
        // identity binding, or each self-read materializes a fresh struct and
        // `spy.mock` reads back undefined in every spy body.
        //
        // (#4616) The var/let/const hoists MUST precede the function hoist —
        // exactly as in function-body.ts. The nested fn's capture collection
        // reads `fctx.localMap` at hoist time; without pre-allocated method
        // locals, a captured method local (`const callList = []` in `vi.fn`)
        // silently misses (`localIdx === undefined` → capture dropped) and the
        // nested body reads it as null (`null.push` in every jest spy).
        hoistVarDeclarations(ctx, methodFctx, prop.body.statements);
        hoistLetConstWithTdz(ctx, methodFctx, prop.body.statements);
        hoistFunctionDeclarations(ctx, methodFctx, prop.body.statements);
        for (const stmt of prop.body.statements) {
          compileStatement(ctx, methodFctx, stmt);
        }
      }
      // Ensure valid return for non-void, non-generator methods
      if (methodFctx.returnType && !isGeneratorMethod) {
        const lastInstr = methodFctx.body[methodFctx.body.length - 1];
        if (!lastInstr || lastInstr.op !== "return") {
          if (methodFctx.returnType.kind === "f64") {
            methodFctx.body.push({ op: "f64.const", value: 0 });
          } else if (methodFctx.returnType.kind === "i32") {
            methodFctx.body.push({ op: "i32.const", value: 0 });
          } else if (methodFctx.returnType.kind === "externref") {
            methodFctx.body.push({ op: "ref.null.extern" });
          } else if (methodFctx.returnType.kind === "ref" || methodFctx.returnType.kind === "ref_null") {
            methodFctx.body.push({ op: "ref.null", typeIdx: methodFctx.returnType.typeIdx });
          }
        }
      }
      cacheStringLiterals(ctx, methodFctx);
      methodFunc.locals = methodFctx.locals;
      methodFunc.body = methodFctx.body;
      if (savedFunc) ctx.funcStack.pop();
      if (savedFunc) ctx.parentBodiesStack.pop();
      ctx.currentFunc = savedFunc;
    }
  }

  return { kind: "ref", typeIdx: structTypeIdx };
}

/**
 * Compile a tuple literal [a, b, c] to a Wasm GC struct.new instruction.
 * Each element is compiled to its corresponding field type.
 */
export function compileTupleLiteral(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.ArrayLiteralExpression,
  tupleType: ts.Type,
): ValType | null {
  const elemTypes = getTupleElementTypes(ctx, tupleType);

  const tupleIdx = getOrRegisterTupleType(ctx, elemTypes);

  // Compile each element with the expected field type.
  // For missing positions (literal shorter than tuple), push default values
  // so the struct.new gets a full set of fields (#852).
  for (let i = 0; i < elemTypes.length; i++) {
    const expectedType = elemTypes[i] ?? { kind: "externref" as const };
    if (i < expr.elements.length) {
      const el = expr.elements[i]!;
      // For holes (OmittedExpression) and explicit `undefined` in f64 context,
      // emit the sNaN sentinel so destructuring default checks trigger correctly
      // (#1024).
      if (expectedType.kind === "f64" && _isUndefinedLike(el)) {
        fctx.body.push({ op: "i64.const", value: 0x7ff00000deadc0den });
        fctx.body.push({ op: "f64.reinterpret_i64" });
      } else {
        compileExpression(ctx, fctx, el, expectedType);
      }
    } else {
      // Missing element — push sentinel value that destructuring recognizes as
      // "absent": sNaN sentinel for f64, JS undefined for externref, ref.null
      // for refs, 0 for i32. For externref we emit `call $__get_undefined` so
      // destructuring defaults (which fire on `=== undefined`, not `null`)
      // trigger correctly when a tuple-typed arg is shorter than the pattern
      // (e.g. `([x = d]) => {}` called with `[]`) — per §8.6.2 (#852, #866).
      if (expectedType.kind === "f64") {
        fctx.body.push({ op: "i64.const", value: 0x7ff00000deadc0den });
        fctx.body.push({ op: "f64.reinterpret_i64" });
      } else if (expectedType.kind === "i32") {
        fctx.body.push({ op: "i32.const", value: 0 });
      } else if (expectedType.kind === "externref") {
        emitUndefined(ctx, fctx);
      } else if (expectedType.kind === "ref_null" || expectedType.kind === "ref") {
        const typeIdx = (expectedType as { typeIdx: number }).typeIdx;
        fctx.body.push({ op: "ref.null", typeIdx });
      } else {
        pushDefaultValue(fctx, expectedType, ctx);
      }
    }
  }

  fctx.body.push({ op: "struct.new", typeIdx: tupleIdx });
  return { kind: "ref", typeIdx: tupleIdx };
}

/**
 * Detect a counted push loop pattern after an empty array literal (#1001):
 *   const arr: number[] = [];
 *   for (let i = 0; i < N; i++) arr.push(expr);
 *
 * Returns the trip count and exact push call when the pattern is statically
 * provable. This allows preallocating the backing WasmGC array and lets that
 * one call omit its now-redundant capacity branch.
 *
 * @irOptimizationOwner IR-OPT-COUNTED-VECTOR-PUSH-PRESIZE
 */
function detectCountedPushLoop(
  expr: ts.ArrayLiteralExpression,
): { tripCount: number; call: ts.CallExpression; arrayName: string } | undefined {
  // Walk up: ArrayLiteralExpression → VariableDeclaration → VariableDeclarationList → VariableStatement → Block/SourceFile
  const varDecl = expr.parent;
  if (!varDecl || !ts.isVariableDeclaration(varDecl) || !ts.isIdentifier(varDecl.name)) return undefined;
  const arrName = varDecl.name.text;

  const declList = varDecl.parent;
  if (!declList || !ts.isVariableDeclarationList(declList)) return undefined;
  const varStmt = declList.parent;
  if (!varStmt || !ts.isVariableStatement(varStmt)) return undefined;

  const block = varStmt.parent;
  if (!block) return undefined;
  let stmts: ts.NodeArray<ts.Statement>;
  if (ts.isBlock(block)) stmts = block.statements;
  else if (ts.isSourceFile(block)) stmts = block.statements;
  else return undefined;

  // Find the variable statement's index and look at the next statement
  const idx = stmts.indexOf(varStmt);
  if (idx < 0 || idx + 1 >= stmts.length) return undefined;
  const nextStmt = stmts[idx + 1]!;
  if (!ts.isForStatement(nextStmt)) return undefined;

  // Check initializer: `let i = 0` or `var i = 0`
  const init = nextStmt.initializer;
  if (!init || !ts.isVariableDeclarationList(init)) return undefined;
  if (init.declarations.length !== 1) return undefined;
  const loopDecl = init.declarations[0]!;
  if (!ts.isIdentifier(loopDecl.name)) return undefined;
  const loopVar = loopDecl.name.text;
  if (!loopDecl.initializer || !ts.isNumericLiteral(loopDecl.initializer) || loopDecl.initializer.text !== "0")
    return undefined;

  // Check condition: `i < N` where N is a numeric literal
  const cond = nextStmt.condition;
  if (!cond || !ts.isBinaryExpression(cond)) return undefined;
  if (cond.operatorToken.kind !== ts.SyntaxKind.LessThanToken) return undefined;
  if (!ts.isIdentifier(cond.left) || cond.left.text !== loopVar) return undefined;
  if (!ts.isNumericLiteral(cond.right)) return undefined;
  const tripCount = Number(cond.right.text);
  if (!Number.isFinite(tripCount) || tripCount <= 0 || tripCount > 1_000_000) return undefined;

  // Check incrementor: `i++` or `i += 1`
  const inc = nextStmt.incrementor;
  if (!inc) return undefined;
  if (ts.isPostfixUnaryExpression(inc)) {
    if (inc.operator !== ts.SyntaxKind.PlusPlusToken) return undefined;
    if (!ts.isIdentifier(inc.operand) || inc.operand.text !== loopVar) return undefined;
  } else if (ts.isPrefixUnaryExpression(inc)) {
    if (inc.operator !== ts.SyntaxKind.PlusPlusToken) return undefined;
    if (!ts.isIdentifier(inc.operand) || inc.operand.text !== loopVar) return undefined;
  } else if (
    ts.isBinaryExpression(inc) &&
    inc.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isIdentifier(inc.left) &&
    inc.left.text === loopVar &&
    ts.isBinaryExpression(inc.right) &&
    inc.right.operatorToken.kind === ts.SyntaxKind.PlusToken &&
    ts.isIdentifier(inc.right.left) &&
    inc.right.left.text === loopVar &&
    ts.isNumericLiteral(inc.right.right) &&
    Number(inc.right.right.text) === 1
  ) {
    // Canonical compiler-friendly spelling used by the benchmark corpus:
    // `i = i + 1`.
  } else {
    return undefined;
  }

  // Check body: must contain only `arr.push(expr)` (as expression statement)
  const body = nextStmt.statement;
  let bodyStmt: ts.Statement;
  if (ts.isBlock(body)) {
    if (body.statements.length !== 1) return undefined;
    bodyStmt = body.statements[0]!;
  } else {
    bodyStmt = body;
  }
  if (!ts.isExpressionStatement(bodyStmt)) return undefined;
  const callExpr = bodyStmt.expression;
  if (!ts.isCallExpression(callExpr)) return undefined;
  if (!ts.isPropertyAccessExpression(callExpr.expression)) return undefined;
  if (callExpr.expression.name.text !== "push") return undefined;
  if (!ts.isIdentifier(callExpr.expression.expression)) return undefined;
  if (callExpr.expression.expression.text !== arrName) return undefined;
  if (callExpr.arguments.length !== 1) return undefined;

  return { tripCount, call: callExpr, arrayName: arrName };
}

/**
 * Detect a counted dense-fill loop pattern after an empty array literal (#1198):
 *   const arr = [];
 *   for (let i = 0; i < N; i++) arr[i] = <pure expr involving i and outer locals>;
 *
 * This is the cousin of `detectCountedPushLoop` for `a[i] = …` instead of
 * `a.push(…)`. The match unlocks pre-sizing the WasmGC backing array to N up
 * front, eliminating O(n²) grow-and-copy churn that the per-write
 * grow-on-demand path emits.
 *
 * Returns the loop-bound `ts.Expression` if the pattern matches, `null`
 * otherwise. The caller compiles the expression to i32 at allocation time
 * (literal `N` is constant-folded into `i32.const N`; an identifier compiles
 * via the normal expression path with an i32 hint).
 *
 * **Conservative checks** — the matcher rejects shapes whose pre-sizing
 * would change observable semantics:
 *
 * - Loop body must be **exactly** `arr[i] = expr` (one expression statement
 *   wrapping a single assignment).
 * - The RHS must be "non-throwing" — only NumericLiteral, Identifier,
 *   PrefixUnary on the above, BinaryExpression composing the above. This
 *   excludes calls, property access, and element access (any of which can
 *   throw in JS, which would leave a partial-fill `arr.length` that doesn't
 *   match the pre-sized value).
 * - LHS must be `arr[i]` exactly — no `arr[i+1]`, no `arr[other]`, no
 *   `arr.field` in the RHS that could read the array under construction.
 * - The loop body must not reference `arr` anywhere else (rules out `arr
 *   .length` reads, which would observe the pre-sized length immediately
 *   instead of the grow-as-you-go length).
 *
 * @irOptimizationOwner IR-OPT-DENSE-VECTOR-PRESIZE
 */
function detectCountedFillLoopBound(expr: ts.ArrayLiteralExpression): ts.Expression | null {
  // Same outer-walk as detectCountedPushLoop: literal must be the
  // initializer of a single variable declaration whose next sibling
  // statement is the for-loop.
  const varDecl = expr.parent;
  if (!varDecl || !ts.isVariableDeclaration(varDecl) || !ts.isIdentifier(varDecl.name)) return null;
  const arrName = varDecl.name.text;

  const declList = varDecl.parent;
  if (!declList || !ts.isVariableDeclarationList(declList)) return null;
  const varStmt = declList.parent;
  if (!varStmt || !ts.isVariableStatement(varStmt)) return null;

  const block = varStmt.parent;
  if (!block) return null;
  let stmts: ts.NodeArray<ts.Statement>;
  if (ts.isBlock(block)) stmts = block.statements;
  else if (ts.isSourceFile(block)) stmts = block.statements;
  else return null;

  const idx = stmts.indexOf(varStmt);
  if (idx < 0 || idx + 1 >= stmts.length) return null;
  const nextStmt = stmts[idx + 1]!;
  if (!ts.isForStatement(nextStmt)) return null;

  // Initializer: `let i = 0` (or var). Single declaration, init === 0.
  const init = nextStmt.initializer;
  if (!init || !ts.isVariableDeclarationList(init)) return null;
  if (init.declarations.length !== 1) return null;
  const loopDecl = init.declarations[0]!;
  if (!ts.isIdentifier(loopDecl.name)) return null;
  const loopVar = loopDecl.name.text;
  if (!loopDecl.initializer || !ts.isNumericLiteral(loopDecl.initializer) || loopDecl.initializer.text !== "0") {
    return null;
  }

  // Condition: `i < BOUND` where BOUND is any expression. We capture it for
  // the caller to compile; we never evaluate it here.
  const cond = nextStmt.condition;
  if (!cond || !ts.isBinaryExpression(cond)) return null;
  if (cond.operatorToken.kind !== ts.SyntaxKind.LessThanToken) return null;
  if (!ts.isIdentifier(cond.left) || cond.left.text !== loopVar) return null;
  const boundExpr = cond.right;

  // BOUND may not reference the array under construction — that would
  // observe the pre-sized length and change semantics.
  if (!isExprFreeOfReference(boundExpr, arrName)) return null;

  // Incrementor: `i++` or `++i`.
  const inc = nextStmt.incrementor;
  if (!inc) return null;
  if (ts.isPostfixUnaryExpression(inc) || ts.isPrefixUnaryExpression(inc)) {
    if (inc.operator !== ts.SyntaxKind.PlusPlusToken) return null;
    if (!ts.isIdentifier(inc.operand) || inc.operand.text !== loopVar) return null;
  } else {
    return null;
  }

  // Body: exactly one expression statement of shape `arr[loopVar] = pureExpr`.
  const bodyStmtNode = nextStmt.statement;
  let bodyStmt: ts.Statement;
  if (ts.isBlock(bodyStmtNode)) {
    if (bodyStmtNode.statements.length !== 1) return null;
    bodyStmt = bodyStmtNode.statements[0]!;
  } else {
    bodyStmt = bodyStmtNode;
  }
  if (!ts.isExpressionStatement(bodyStmt)) return null;
  const assign = bodyStmt.expression;
  if (!ts.isBinaryExpression(assign)) return null;
  if (assign.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return null;

  // LHS: `arr[loopVar]`.
  const lhs = assign.left;
  if (!ts.isElementAccessExpression(lhs)) return null;
  if (!ts.isIdentifier(lhs.expression) || lhs.expression.text !== arrName) return null;
  if (!ts.isIdentifier(lhs.argumentExpression) || lhs.argumentExpression.text !== loopVar) return null;

  // RHS must be pure (non-throwing) AND must not reference the array.
  if (!isPureFillRhs(assign.right, arrName)) return null;

  return boundExpr;
}

/**
 * Is `expr` a "pure" fill RHS — guaranteed non-throwing and free of any read
 * of `arrName`? Conservative: only literals, identifier reads, parenthesized
 * versions of those, and unary / binary compositions of the above.
 */
function isPureFillRhs(expr: ts.Expression, arrName: string): boolean {
  if (ts.isParenthesizedExpression(expr)) return isPureFillRhs(expr.expression, arrName);
  if (ts.isNumericLiteral(expr)) return true;
  if (expr.kind === ts.SyntaxKind.TrueKeyword || expr.kind === ts.SyntaxKind.FalseKeyword) return true;
  if (expr.kind === ts.SyntaxKind.NullKeyword) return true;
  if (ts.isStringLiteral(expr)) return true;
  if (ts.isIdentifier(expr)) {
    // Plain identifier read is pure (variable access doesn't throw); but we
    // must reject reads of the array under construction.
    return expr.text !== arrName;
  }
  if (ts.isPrefixUnaryExpression(expr)) {
    const op = expr.operator;
    // Only allow safely-pure unary ops. `++`/`--` are mutations (could
    // touch the array if the operand is a complex thing); we keep it
    // simple and allow `+` `-` `~` `!` only.
    if (
      op === ts.SyntaxKind.PlusToken ||
      op === ts.SyntaxKind.MinusToken ||
      op === ts.SyntaxKind.TildeToken ||
      op === ts.SyntaxKind.ExclamationToken
    ) {
      return isPureFillRhs(expr.operand, arrName);
    }
    return false;
  }
  if (ts.isBinaryExpression(expr)) {
    // Reject assignment / compound-assignment.
    const k = expr.operatorToken.kind;
    if (
      k === ts.SyntaxKind.EqualsToken ||
      k === ts.SyntaxKind.PlusEqualsToken ||
      k === ts.SyntaxKind.MinusEqualsToken ||
      k === ts.SyntaxKind.AsteriskEqualsToken ||
      k === ts.SyntaxKind.SlashEqualsToken ||
      k === ts.SyntaxKind.PercentEqualsToken ||
      k === ts.SyntaxKind.AmpersandEqualsToken ||
      k === ts.SyntaxKind.BarEqualsToken ||
      k === ts.SyntaxKind.CaretEqualsToken ||
      k === ts.SyntaxKind.LessThanLessThanEqualsToken ||
      k === ts.SyntaxKind.GreaterThanGreaterThanEqualsToken ||
      k === ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken ||
      k === ts.SyntaxKind.AsteriskAsteriskEqualsToken ||
      k === ts.SyntaxKind.QuestionQuestionEqualsToken ||
      k === ts.SyntaxKind.BarBarEqualsToken ||
      k === ts.SyntaxKind.AmpersandAmpersandEqualsToken ||
      k === ts.SyntaxKind.CommaToken
    ) {
      return false;
    }
    return isPureFillRhs(expr.left, arrName) && isPureFillRhs(expr.right, arrName);
  }
  return false;
}

/**
 * Cheap walk that returns true iff `expr` doesn't textually reference
 * the identifier `name`. We scan the AST and reject any Identifier whose
 * text matches; PropertyAccessExpression names (the `.foo` part) are
 * skipped because they are not variable references.
 */
function isExprFreeOfReference(expr: ts.Node, name: string): boolean {
  if (ts.isIdentifier(expr)) return expr.text !== name;
  if (ts.isPropertyAccessExpression(expr)) {
    return isExprFreeOfReference(expr.expression, name);
    // expr.name is a property *name*, not a variable reference — skipped.
  }
  let ok = true;
  expr.forEachChild((child) => {
    if (!ok) return;
    if (!isExprFreeOfReference(child, name)) ok = false;
  });
  return ok;
}

/**
 * (#3532) Element wasm type for a bare empty `[]` from its contextual type.
 * Handles a direct `Array<T>`/`ReadonlyArray<T>` context AND a UNION context
 * (e.g. flatMap's `U | readonly U[]`) with array member(s), so `[]` adopts the
 * array member's element type and registers the SAME vec type as a sibling
 * `[x]` in the same conditional (`cond ? [] : [x]`) — otherwise the union falls
 * through to `externref` while `[x]` is a numeric vec → invalid closure. Only
 * adopts a union's element type when EVERY array member resolves to the same
 * wasm type (ambiguous otherwise, e.g. `number[] | string[]` → keep externref).
 */
function resolveEmptyArrayElemWasm(ctx: CodegenContext, ctxType: ts.Type): ValType | undefined {
  const fromArrayType = (t: ts.Type): ValType | undefined => {
    const sym = (t as ts.TypeReference).symbol ?? t.symbol;
    if (sym?.name === "Array" || sym?.name === "ReadonlyArray") {
      const typeArgs = ctx.checker.getTypeArguments(t as ts.TypeReference);
      if (typeArgs[0]) return resolveWasmType(ctx, typeArgs[0]);
    }
    return undefined;
  };
  const direct = fromArrayType(ctxType);
  if (direct) return direct;
  if (ctxType.isUnion()) {
    const elems: ValType[] = [];
    for (const part of ctxType.types) {
      const e = fromArrayType(part);
      if (e) elems.push(e);
    }
    if (elems.length > 0 && elems.every((e) => valTypesMatch(e, elems[0]!))) {
      return elems[0];
    }
  }
  return undefined;
}

/**
 * (#4531) Does this array literal's VALUE escape into an `any`/`unknown`-typed
 * (or unresolvable) call argument — either directly (`f([{…}])`) or through a
 * const/let binding that is later passed as such an argument? An opaque
 * consumer may mutate the array dynamically (push an OPEN host `$Object`),
 * which a closed-struct element carrier cannot store; the caller widens the
 * carrier to externref when this answers true. Fail-closed: any shape this
 * scan cannot prove answers false and the literal keeps its typed carrier.
 */
const escapeWidenCache = new WeakMap<ts.ArrayLiteralExpression, boolean>();

/**
 * (#4531) Shared decision for the escape widening: BOTH the array literal's
 * element carrier (compileArrayLiteral below) and the binding's slot type
 * (statements/variables.ts declaration cascade) must answer identically, or a
 * vec→vec converting copy between the two representations nulls every element
 * that fails the closed-struct ref.test. Syntactic gate: non-empty, spread- and
 * hole-free, every element in the object/function domain (the closed-struct
 * element lane); then the escape scan.
 */
export function arrayLiteralEscapeWidensToExternref(ctx: CodegenContext, expr: ts.ArrayLiteralExpression): boolean {
  const cached = escapeWidenCache.get(expr);
  if (cached !== undefined) return cached;
  let result = expr.elements.length > 0;
  for (const element of expr.elements) {
    if (!result) break;
    if (ts.isSpreadElement(element) || ts.isOmittedExpression(element)) result = false;
    else {
      const tag = ctx.oracle.staticJsTypeOf(element);
      if (tag !== "object" && tag !== "function") result = false;
    }
  }
  if (result) result = arrayLiteralEscapesToOpaqueConsumer(ctx, expr);
  escapeWidenCache.set(expr, result);
  return result;
}

function arrayLiteralEscapesToOpaqueConsumer(ctx: CodegenContext, expr: ts.ArrayLiteralExpression): boolean {
  const callArgIsOpaque = (call: ts.CallExpression, arg: ts.Node): boolean => {
    const argIndex = call.arguments.findIndex((a) => a === arg);
    if (argIndex < 0) return false;
    if (!ts.isIdentifier(call.expression) && !ts.isPropertyAccessExpression(call.expression)) return false;
    const decl = ctx.oracle.valueDeclarationOf(
      ts.isIdentifier(call.expression) ? call.expression : call.expression.name,
    );
    let fnLike: ts.SignatureDeclaration | undefined;
    if (decl !== undefined) {
      if (ts.isFunctionDeclaration(decl) || ts.isMethodDeclaration(decl)) fnLike = decl;
      else if (
        ts.isVariableDeclaration(decl) &&
        decl.initializer &&
        (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))
      ) {
        fnLike = decl.initializer;
      }
    }
    if (fnLike === undefined) return false; // dynamic/imported callee — keep typed carrier (fail-closed)
    const param = fnLike.parameters[Math.min(argIndex, fnLike.parameters.length - 1)];
    if (param === undefined) return false;
    if (param.dotDotDotToken !== undefined) return false;
    // JS param with no annotation = implicit any; an explicit any/unknown
    // annotation counts too.
    if (param.type === undefined) return true;
    const paramFact = ctx.oracle.typeFactOf(param);
    return paramFact.kind === "any" || paramFact.kind === "unknown";
  };

  let node: ts.Node = expr;
  while (node.parent && ts.isParenthesizedExpression(node.parent)) node = node.parent;
  const parent = node.parent;
  if (parent === undefined) return false;
  if (ts.isCallExpression(parent) && (parent.arguments as readonly ts.Node[]).includes(node)) {
    return callArgIsOpaque(parent, node);
  }
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    const bindingName = parent.name.text;
    // Scope of the scan: the enclosing function-like body (or source file).
    let scope: ts.Node = parent;
    for (let up: ts.Node | undefined = parent.parent; up; up = up.parent) {
      scope = up;
      if (ts.isFunctionLike(up) || ts.isSourceFile(up)) break;
    }
    let escapes = false;
    const visit = (n: ts.Node): void => {
      if (escapes) return;
      if (ts.isIdentifier(n) && n.text === bindingName && n !== parent.name) {
        const call = n.parent;
        if (call && ts.isCallExpression(call) && (call.arguments as readonly ts.Node[]).includes(n)) {
          // Binding identity via the oracle (never the bare name): the
          // occurrence must resolve to THIS declaration.
          if (ctx.oracle.variableDeclarationOf(n) === parent && callArgIsOpaque(call, n)) escapes = true;
        }
      }
      if (!escapes) ts.forEachChild(n, visit);
    };
    visit(scope);
    return escapes;
  }
  return false;
}

export function compileArrayLiteral(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.ArrayLiteralExpression,
  forcedElementType?: ValType,
): ValType | null {
  // (#3366) A destructuring assignment gives its RHS array literal the
  // assignment pattern's contextual tuple type. That context describes the
  // TARGET defaults, not necessarily the values in the source literal: for
  // `[x = numberDefault()] = [callableAny]`, TypeScript reports a numeric tuple
  // context even though the actual element is a callable/dynamic JS value.
  // Compiling that element into the contextual f64 tuple coerces it to NaN
  // before destructuring can observe it. Dynamic/callable elements therefore
  // require the universal externref vec carrier; skip contextual tuple lowering
  // and preserve their runtime tag/identity.
  const hasDynamicOrCallableElement = expr.elements.some((element) => {
    if (ts.isOmittedExpression(element)) return false;
    const value = ts.isSpreadElement(element) ? element.expression : element;
    const fact = ctx.oracle.typeFactOf(value);
    return fact.kind === "any" || fact.kind === "unknown" || fact.kind === "function";
  });
  let assignmentValue: ts.Expression = expr;
  while (
    ts.isParenthesizedExpression(assignmentValue.parent) ||
    ts.isAsExpression(assignmentValue.parent) ||
    ts.isTypeAssertionExpression(assignmentValue.parent) ||
    ts.isNonNullExpression(assignmentValue.parent)
  ) {
    assignmentValue = assignmentValue.parent;
  }
  const assignmentParent = assignmentValue.parent;
  const isDestructuringAssignmentValue =
    ts.isBinaryExpression(assignmentParent) &&
    assignmentParent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    assignmentParent.right === assignmentValue &&
    (ts.isArrayLiteralExpression(assignmentParent.left) || ts.isObjectLiteralExpression(assignmentParent.left));

  // Check if the target type is a tuple — compile as struct.new instead of array.
  // Skip if _arrayLiteralForceVec is set (e.g. destructuring default where the target
  // is a vec type, but TS contextual type resolution sees a tuple pattern).
  const ctxTupleType = ctx.checker.getContextualType(expr) ?? ctx.checker.getTypeAtLocation(expr);
  if (
    ctxTupleType &&
    isTupleType(ctxTupleType) &&
    !(ctx as any)._arrayLiteralForceVec &&
    !(hasDynamicOrCallableElement && isDestructuringAssignmentValue)
  ) {
    // When the contextual type gives degenerate tuple types (e.g. all void from
    // destructuring defaults: `[w = counter()] = [null, 0, false, '']`),
    // prefer getTypeAtLocation which reflects the actual literal element types (#801).
    let tupleType = ctxTupleType;
    const ctxElemTypes = getTupleElementTypes(ctx, ctxTupleType);
    // If the contextual tuple type has fewer slots than the literal has
    // elements, the tuple would truncate data. Fall through to vec path (#971).
    // This applies to single-element literals too: `.apply(null, [...source])`
    // is contextually typed as the zero-slot tuple `[]` when the callback has no
    // formal parameters. The previous `elements.length > 1` gate compiled that
    // dynamic spread as an empty tuple and silently discarded every argument
    // (#3368).
    if (ctxElemTypes.length < expr.elements.length) {
      // Don't use tuple — fall through to vec
    } else if (expr.elements.length > 1) {
      const allSameKind = ctxElemTypes.length > 0 && ctxElemTypes.every((t) => t.kind === ctxElemTypes[0]!.kind);
      if (allSameKind) {
        const actualType = ctx.checker.getTypeAtLocation(expr);
        if (actualType && isTupleType(actualType)) {
          const actualElemTypes = getTupleElementTypes(ctx, actualType);
          const actualHeterogeneous =
            actualElemTypes.length > 1 && !actualElemTypes.every((t) => t.kind === actualElemTypes[0]!.kind);
          if (actualHeterogeneous) {
            // Don't switch to the actual type if the heterogeneity is only
            // from undefined/void holes (i32) mixed with f64. The contextual
            // type's f64 is better because it supports the sNaN sentinel for
            // destructuring default checks. Switching to [i32, i32, f64] would
            // lose default-value detection on the hole positions (#1024).
            const onlyUndefinedHeterogeneity =
              actualElemTypes.every((t) => t.kind === "f64" || t.kind === "i32") &&
              actualElemTypes.some((t) => t.kind === "i32") &&
              actualElemTypes.some((t) => t.kind === "f64");
            if (!onlyUndefinedHeterogeneity) {
              tupleType = actualType;
            }
          }
        }
      }
      return compileTupleLiteral(ctx, fctx, expr, tupleType);
    } else {
      return compileTupleLiteral(ctx, fctx, expr, tupleType);
    }
  }

  if (expr.elements.length === 0) {
    // Detect counted push loop pattern and preallocate (#1001)
    const countedPush = detectCountedPushLoop(expr);
    const prealloc = countedPush?.tripCount ?? 0;
    // Detect counted dense-fill loop pattern (#1198) — sister of the
    // push-loop matcher. When the array is followed by a
    // `for (let i = 0; i < N; i++) arr[i] = pureExpr` loop, we know the
    // final length is exactly N and we can pre-size both the data buffer
    // and the vec.length field, eliminating the O(n²) grow-and-copy cost
    // the per-write grow-on-demand path otherwise pays.
    const fillBoundExpr = prealloc > 0 ? null : detectCountedFillLoopBound(expr);

    // Empty array — try to determine element type from contextual type (e.g. number[]).
    // Handles a direct `Array<T>`/`ReadonlyArray<T>` context AND a union context
    // (e.g. flatMap's `U | readonly U[]`) so `[]` in `cond ? [] : [x]` adopts the
    // sibling's concrete vec type instead of mis-defaulting to externref (#3532).
    let emptyElemKind = "externref";
    const ctxType = ctx.checker.getContextualType(expr) ?? ctx.checker.getTypeAtLocation(expr);
    if (ctxType) {
      const elemWasmType = resolveEmptyArrayElemWasm(ctx, ctxType);
      if (elemWasmType) {
        emptyElemKind =
          elemWasmType.kind === "ref" || elemWasmType.kind === "ref_null"
            ? `ref_${(elemWasmType as { typeIdx: number }).typeIdx}`
            : elemWasmType.kind;
      }
    }
    const vecTypeIdx = getOrRegisterVecType(ctx, emptyElemKind);
    const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
    if (arrTypeIdx < 0) {
      reportError(ctx, expr, "Empty array literal: invalid vec type");
      return null;
    }
    if (countedPush) {
      registerCountedPushArray(fctx, countedPush, vecTypeIdx);
    }

    if (fillBoundExpr !== null) {
      // Dense-fill prealloc (#1198): emit `vec.length = N` AND
      // `vec.data = array.new_default(N)`. Setting length=N up front
      // matches the post-loop observable state — `arr.length === N`
      // after every iteration writes its slot — so the optimization
      // preserves semantics for the canonical pattern detected.
      //
      // For a literal-numeric bound, fold to `i32.const N`.
      // Otherwise compile the bound expression with an i32 hint and
      // tee into a temp local so we can use it for both the struct's
      // length field and the array.new_default size.
      if (ts.isNumericLiteral(fillBoundExpr)) {
        const n = Number(fillBoundExpr.text);
        if (Number.isFinite(n) && n >= 0 && n <= 1_000_000_000) {
          fctx.body.push({ op: "i32.const", value: n }); // length field
          fctx.body.push({ op: "i32.const", value: n }); // size for array.new_default
          fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
          fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
          return { kind: "ref_null", typeIdx: vecTypeIdx };
        }
        // Fall through to the empty-allocation path on out-of-range
        // literals; preserves grow-on-write semantics for pathological
        // cases without changing observable behaviour.
      } else {
        // Identifier or expression bound. Compile with i32 hint and
        // stash in a temp local so we can re-emit it for both fields.
        const tmpN = allocTempLocal(fctx, { kind: "i32" });
        compileExpression(ctx, fctx, fillBoundExpr, { kind: "i32" });
        fctx.body.push({ op: "local.tee", index: tmpN }); // length field (top of stack)
        fctx.body.push({ op: "local.get", index: tmpN }); // size for array.new_default
        fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
        fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
        releaseTempLocal(fctx, tmpN);
        return { kind: "ref_null", typeIdx: vecTypeIdx };
      }
    }

    fctx.body.push({ op: "i32.const", value: 0 }); // length field (field 0)
    // (#3921 follow-up) With no prealloc the backing store is zero-length and
    // DEAD ON ARRIVAL — `push` grows on `capacity < length + argc`, which from
    // capacity 0 always trips, so the first push replaces it. Share one
    // immutable singleton per element type instead of allocating 31,414 of
    // them per acorn parse. Prealloc'd literals keep their own store.
    const sharedEmpty = prealloc > 0 ? undefined : emptyBackingStoreInstrs(ctx, arrTypeIdx);
    if (sharedEmpty) {
      for (const instr of sharedEmpty) fctx.body.push(instr);
    } else {
      fctx.body.push({ op: "i32.const", value: prealloc > 0 ? prealloc : 0 }); // size for array.new_default (#1001: preallocate if counted push loop detected)
      fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx }); // data field (field 1)
    }
    fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx }); // wrap in vec struct
    return { kind: "ref_null", typeIdx: vecTypeIdx };
  }

  // Check if any element is a spread
  const hasSpread = expr.elements.some((el) => ts.isSpreadElement(el));

  // Determine element type from first non-omitted, non-spread element, or from spread source.
  // (#1553e) Prefer a non-undefined-like, non-omitted element so a literal like
  // `[undefined, 2, 3]` infers f64 from `2` rather than externref from `undefined`.
  // The sentinel-emit path below relies on `elemWasm.kind === "f64"` to fire the
  // destructuring default for explicit `undefined` (or `undefined as any`) entries.
  let elemWasm: ValType;
  // biome-ignore lint/style/useConst: reassigned in branches below
  let elemKind: string;
  const isRealElem = (el: ts.Expression): boolean => !ts.isOmittedExpression(el) && !_isUndefinedLike(el);
  const firstSignificantElem =
    expr.elements.find(isRealElem) ?? expr.elements.find((el) => !ts.isOmittedExpression(el));
  const firstElem = firstSignificantElem ?? expr.elements[0]!;
  if (ts.isSpreadElement(firstElem)) {
    const spreadType = ctx.checker.getTypeAtLocation(firstElem.expression);
    if (ctx.nativeStrings && ctx.anyStrTypeIdx >= 0 && isStringType(spreadType)) {
      // (#1470) String spread iterates code points (§22.1.5.1) — each
      // element is a single-code-point string. Must match the element type
      // `__str_to_char_vec` produces (same key as `__str_split`'s string[]).
      elemWasm = { kind: "ref_null", typeIdx: ctx.anyStrTypeIdx };
    } else {
      const typeArgs = ctx.checker.getTypeArguments(spreadType as ts.TypeReference);
      const innerType = typeArgs[0];
      elemWasm = innerType ? resolveWasmType(ctx, innerType) : { kind: "f64" };
    }
  } else if (ts.isOmittedExpression(firstElem) || _isUndefinedLike(firstElem)) {
    // All elements are omitted or undefined-like — consult the contextual type
    // to choose an element kind so destructuring defaults fire correctly (#1553e).
    // Falls back to externref (undefined) when no contextual hint is available.
    elemWasm = { kind: "externref" };
    const ctxType = ctx.checker.getContextualType(expr);
    if (ctxType) {
      const ctxSym = (ctxType as ts.TypeReference).symbol ?? ctxType.symbol;
      if (ctxSym?.name === "Array" || ctxSym?.name === "ReadonlyArray") {
        const typeArgs = ctx.checker.getTypeArguments(ctxType as ts.TypeReference);
        if (typeArgs[0]) {
          const ctxElemWasm = resolveWasmType(ctx, typeArgs[0]);
          // Only adopt the contextual element type if it's a primitive numeric
          // kind — for ref types, mixing undefined-like (externref-undefined)
          // with a struct ref is messy. The sentinel sNaN technique only helps
          // for f64. For i32, we keep externref (no reliable sentinel exists,
          // see emitDefaultValueCheck).
          if (ctxElemWasm.kind === "f64") {
            elemWasm = ctxElemWasm;
          }
        }
      }
    }
  } else {
    const firstElemType = ctx.checker.getTypeAtLocation(firstElem);
    elemWasm = resolveWasmType(ctx, firstElemType);
    if (hasDynamicOrCallableElement) {
      elemWasm = { kind: "externref" };
    }
    // (#4632) A `symbol`-typed element must not collapse into the numeric i32
    // vec: the id would lose its brand per element, so a reflective consumer
    // (`Array.prototype.map.call(arr, String)` in the test262 compareArray
    // formatter) rendered the raw counter ("[101]") instead of
    // "[Symbol(desc)]". Force the externref carrier vec — the element compile
    // below runs with an externref hint, and the expressions.ts ESSymbolLike
    // arm boxes each id via `__box_symbol` (interned `$Symbol`), which every
    // reflective reader (String, typeof, sameValue, symbol-keying) already
    // understands. Native-symbol lanes only; the js-host lane keeps its vec
    // selection byte-identical (the 2026-08-23 park precedent for brand leaks).
    if (process.env.JS2_SYM_DEBUG)
      console.error(
        "[arr-lit]",
        expr.getText().slice(0, 30),
        "elemWasm=",
        elemWasm.kind,
        "symLike=",
        (firstElemType.flags & ts.TypeFlags.ESSymbolLike) !== 0,
      );
    if (
      usesNativeSymbolProvider(ctx) &&
      elemWasm.kind === "i32" &&
      (firstElemType.flags & ts.TypeFlags.ESSymbolLike) !== 0
    ) {
      elemWasm = { kind: "externref" };
    }
    // (#2021) The first element's class type can be a SUBTYPE of the array's
    // declared element type — e.g. `const a: Shape[] = [new Circle(), new
    // Shape()]` derives `(ref $Circle)` from element 0, but a later `new
    // Shape()` cannot satisfy `(ref $Circle)` and ends up null → trap. When the
    // first element resolves to a struct ref AND a contextual `Array<T>`
    // annotation is present whose element type resolves to a (different) struct
    // ref, prefer the annotation's element type: it is the declared common
    // supertype that holds every element. TS has already verified each element
    // is assignable to `T`, so widening to it is sound. (`[new Shape(), new
    // Circle()]` — base first — already worked because element 0 IS the
    // supertype; this fixes the subclass-first ordering.)
    let hasContextualRefCarrier = false;
    if (elemWasm.kind === "ref" || elemWasm.kind === "ref_null") {
      const ctxType = ctx.checker.getContextualType(expr);
      if (ctxType) {
        const ctxSym = (ctxType as ts.TypeReference).symbol ?? ctxType.symbol;
        if (ctxSym?.name === "Array" || ctxSym?.name === "ReadonlyArray") {
          const ctxElemType = ctx.checker.getTypeArguments(ctxType as ts.TypeReference)[0];
          if (ctxElemType) {
            const ctxElemWasm = resolveWasmType(ctx, ctxElemType);
            if (
              (ctxElemWasm.kind === "ref" || ctxElemWasm.kind === "ref_null") &&
              ctxElemWasm.typeIdx !== elemWasm.typeIdx
            ) {
              elemWasm = ctxElemWasm;
            }
            hasContextualRefCarrier = ctxElemWasm.kind === "ref" || ctxElemWasm.kind === "ref_null";
          }
        }
      }
    }
    // (#4289) With no declared common ref carrier, a plain object array is not
    // allowed to assume every element has element zero's exact closed struct.
    // `{a: ...}` and `{d: ...}` are distinct WasmGC structs; coercing the latter
    // into the former emits `ref.test` → `ref.null` → `ref.as_non_null` and
    // traps while constructing otherwise valid JavaScript. Preserve every
    // value in the canonical externref vec when the static field sets differ
    // (or cannot be proven equal). Homogeneous literals and contextually typed
    // `Array<T>` carriers retain their closed representation.
    if (
      !hasSpread &&
      !hasContextualRefCarrier &&
      (elemWasm.kind === "ref" || elemWasm.kind === "ref_null") &&
      hasIncompatibleObjectLiteralCarrier(ctx, expr, firstElem)
    ) {
      elemWasm = { kind: "externref" };
    }
    // (#4290) A contextual union such as `(RegExpRouter | TrieRouter)[]`
    // can make TypeScript report that same union for each `new` expression.
    // The generic type mapper then picks one concrete struct for the union,
    // even though the other constructor returns an unrelated struct. Preserve
    // the exact declaration identities of imported class expressions: when
    // they differ and the selected carrier is not a real common base, use the
    // universal ref vec instead of guard-casting a valid instance to null.
    const constructedClassNames = !hasSpread ? exactConstructedClassNames(ctx, expr) : null;
    if (
      constructedClassNames &&
      new Set(constructedClassNames).size > 1 &&
      !isCommonClassCarrier(ctx, elemWasm, constructedClassNames)
    ) {
      elemWasm = { kind: "externref" };
    }
    // If the literal mixes a `null` literal with another kind (e.g. `[1, null]`),
    // fall back to externref so the null survives. Without this, null gets coerced
    // to f64 0 and destructuring defaults misbehave (#1021). We gate on `null`
    // specifically rather than any heterogeneity, because promoting on other
    // mismatches (`[7, undefined]`, `[0, "last"]`) causes downstream regressions
    // in paths that rely on the first-element heuristic.
    if (elemWasm.kind !== "externref") {
      const hasNullLiteral = expr.elements.some((e) => e.kind === ts.SyntaxKind.NullKeyword);
      if (hasNullLiteral) {
        elemWasm = { kind: "externref" };
      } else if (elemWasm.kind === "f64" || elemWasm.kind === "i32") {
        // A literal whose first element is numeric but which also contains a
        // genuine object/reference element (e.g. `[0, 1, obj]`) must not store
        // that object into an f64/i32 vec — the object reference would be
        // coerced to a number and lost, so `[0,1,o].indexOf(o)` could never
        // match (#786). Promote the whole vec to externref so object identity
        // survives. Scoped to struct-ref / non-undefined externref elements:
        // strings and numbers keep the numeric/native-string fast path.
        const hasObjectElem = expr.elements.some((el) => {
          if (ts.isOmittedExpression(el) || _isUndefinedLike(el) || ts.isSpreadElement(el)) return false;
          // (#4394) The StringLiteral carve-out below keeps the numeric fast
          // path for the native-strings lanes, where a widening decision is
          // made by the dedicated `hasNativeStringElem` scan further down. In
          // the JS-host/GC lane there is no such scan and a string element is
          // plain `externref`, so excluding the LITERAL form made the literal
          // and non-literal spellings of the same array disagree:
          //
          //   var s = "a"; [0, s]    // widened → "a" survives
          //   [0, "a"]               // NOT widened → f64 vec → reads back NaN
          //
          // That is what makes compareArray.js report `[0, 'a', undefined]` as
          // `[0, NaN, NaN]`, so `compareArray(first, second)` answers `true`
          // for arrays that differ only in their string elements.
          if (el.kind === ts.SyntaxKind.StringLiteral && ctx.nativeStrings) return false;
          const t = resolveWasmType(ctx, ctx.checker.getTypeAtLocation(el));
          return t.kind === "ref" || t.kind === "ref_null" || t.kind === "externref";
        });
        // (#2190b) Mirror of the string-first widening below for the NUMERIC-FIRST
        // ordering: `[7, "ab"]` (a `[number, string]` tuple) picks an f64/i32 vec
        // from element 0, then DROPS the native-string element (it is
        // `extern.convert_any`'d + `__unbox_number`'d to NaN) — so `e[0][1]` reads
        // back NaN and `(… as string)` traps. The `hasObjectElem` scan above
        // deliberately EXCLUDES strings (a genuine numeric literal keeps its fast
        // path), so detect a native-string element separately and only under an
        // `any` contextual element type — the heterogeneous-tuple-in-`any[]` case.
        // A real `(number|string)[]` / `number[]` literal is untouched (its
        // contextual element type is not `any`), preserving the #1021/#786
        // first-element fast path and the historical `[0, "last"]` behaviour.
        let hasNativeStringElem = false;
        if (!hasObjectElem && ctx.nativeStrings && ctx.anyStrTypeIdx >= 0) {
          // An inner tuple `[7, "ab"]` of an `any[]` is contextually typed `any`
          // DIRECTLY (not `Array<any>`); a top-level `const a: any[] = [7, "ab"]`
          // is contextually `Array<any>` (element type `any`). Accept either — both
          // mean "no declared element constraint", which is the only case where a
          // numeric-first literal may legitimately also hold a string element.
          const ctxArrTypeNum = ctx.checker.getContextualType(expr);
          const ctxElemNum =
            ctxArrTypeNum && (ctxArrTypeNum.flags & ts.TypeFlags.Any) !== 0
              ? ctxArrTypeNum
              : ctxArrTypeNum
                ? ctx.checker.getTypeArguments(ctxArrTypeNum as ts.TypeReference)[0]
                : undefined;
          // (#4394, standalone twin of the GC-lane StringLiteral fix above) An
          // UNANNOTATED binding (`var fixture = [0, 'a', undefined]`) has NO
          // contextual type at all — the inferred `(number|string|undefined)[]`
          // is exactly as unconstrained as `any`, but the `ctxElemNum` gate
          // below only accepted the literal-`any` spelling. The numeric-first
          // heuristic then kept the f64 vec and the string/undefined elements
          // read back NaN (`compareArray.format` printed `[0, NaN, NaN]`). A
          // declared `number[]` / `(number|string)[]` context still bypasses
          // this scan (ctxArrTypeNum is defined), preserving the #1021/#786
          // first-element fast path.
          if (ctxArrTypeNum === undefined || (ctxElemNum && (ctxElemNum.flags & ts.TypeFlags.Any) !== 0)) {
            hasNativeStringElem = expr.elements.some((el) => {
              if (ts.isOmittedExpression(el) || _isUndefinedLike(el) || ts.isSpreadElement(el)) return false;
              if (el.kind === ts.SyntaxKind.StringLiteral) return true;
              const t = resolveWasmType(ctx, ctx.checker.getTypeAtLocation(el));
              if (t.kind === "ref" || t.kind === "ref_null") {
                const ti = (t as { typeIdx: number }).typeIdx;
                return ti === ctx.anyStrTypeIdx || ti === ctx.nativeStrTypeIdx;
              }
              return false;
            });
          }
        }
        if (hasObjectElem || hasNativeStringElem) {
          elemWasm = { kind: "externref" };
        }
      } else if (
        (elemWasm.kind === "ref" || elemWasm.kind === "ref_null") &&
        (() => {
          // (#4616, clsx `[[fn], 'world']`) VEC-FIRST mirror of the widenings
          // around it: element 0 is a nested array, so the first-element
          // heuristic picks that vec type for the whole literal — and a later
          // STRING element is then coerced string→vec, i.e. split into its
          // char array ("world" reads back as "w,o,r,l,d"; clsx joined it as
          // "w o r l d"). If any element's own static type is not that same
          // vec shape, widen the carrier to externref so each element keeps
          // its identity.
          const td = ctx.mod.types[(elemWasm as { typeIdx: number }).typeIdx];
          const tn = td && "name" in td ? (td as { name?: string }).name : undefined;
          return tn !== undefined && (tn.startsWith("__vec_") || tn.startsWith("__arr_") || tn === "__vec_base");
        })()
      ) {
        const hasNonVecElem = expr.elements.some((el) => {
          if (ts.isOmittedExpression(el) || _isUndefinedLike(el) || ts.isSpreadElement(el)) return false;
          if (ts.isArrayLiteralExpression(el)) return false;
          // Oracle-fact scan (#1930): an array/tuple-shaped element keeps the
          // vec carrier (vec→vec coercion handles element-type divergence);
          // any other shape — string, number, function, object — must widen.
          const fact = ctx.oracle.typeFactOf(el);
          return fact.kind !== "array" && fact.kind !== "tuple";
        });
        if (hasNonVecElem) {
          elemWasm = { kind: "externref" };
        }
      } else if (
        ctx.nativeStrings &&
        ctx.anyStrTypeIdx >= 0 &&
        (elemWasm.kind === "ref" || elemWasm.kind === "ref_null") &&
        ((elemWasm as { typeIdx: number }).typeIdx === ctx.anyStrTypeIdx ||
          (elemWasm as { typeIdx: number }).typeIdx === ctx.nativeStrTypeIdx)
      ) {
        // (#2190 residual / #2190b) The first element is a native string, so the
        // first-element heuristic picked `$AnyString` for the whole vec — but a
        // heterogeneous literal like `["a", 1]` (a `[string, number]` tuple,
        // common as an `Object.fromEntries` entry) then DROPS the non-string
        // element (`f64.const 1; drop`) and substitutes `ref.null $AnyString;
        // ref.as_non_null` → a guaranteed null-deref trap on a later read. Mirror
        // the numeric-first `hasObjectElem` widening: if any element is NOT a
        // native string, widen the vec to `externref` so each element is boxed by
        // its own static type (`__box_number`/`__box_boolean`/native-string) at
        // construction. Scoped to native-strings mode (true under standalone and
        // WASI); number[]/struct[] etc. are untouched (their first element isn't a
        // native string).
        const hasNonStringElem = expr.elements.some((el) => {
          if (ts.isOmittedExpression(el) || ts.isSpreadElement(el)) return false;
          if (el.kind === ts.SyntaxKind.StringLiteral) return false;
          const t = resolveWasmType(ctx, ctx.checker.getTypeAtLocation(el));
          if (t.kind === "ref" || t.kind === "ref_null") {
            const ti = (t as { typeIdx: number }).typeIdx;
            return ti !== ctx.anyStrTypeIdx && ti !== ctx.nativeStrTypeIdx;
          }
          // f64 / i32 / externref / etc. — a non-string element.
          return true;
        });
        if (hasNonStringElem) {
          elemWasm = { kind: "externref" };
        }
      } else if (
        ctx.nativeStrings &&
        ctx.anyStrTypeIdx >= 0 &&
        (elemWasm.kind === "ref" || elemWasm.kind === "ref_null") &&
        ((elemWasm as { typeIdx: number }).typeIdx === ctx.anyStrTypeIdx ||
          (elemWasm as { typeIdx: number }).typeIdx === ctx.nativeStrTypeIdx)
      ) {
        // (#2190 residual) The first element is a native string, so the
        // first-element heuristic picked `$AnyString` for the whole vec — but a
        // heterogeneous literal like `["a", 1]` (a `[string, number]` tuple,
        // common as an `Object.fromEntries` entry) then DROPS the non-string
        // element (`f64.const 1; drop`) and substitutes `ref.null $AnyString;
        // ref.as_non_null` → a guaranteed null-deref trap on a later read. Mirror
        // the numeric-first `hasObjectElem` widening: if any element is NOT a
        // native string, widen the vec to `externref` so each element is boxed by
        // its own static type (`__box_number`/`__box_boolean`/native-string) at
        // construction. Scoped to native-strings mode; number[]/struct[] etc. are
        // untouched (their first element isn't a string).
        const hasNonStringElem = expr.elements.some((el) => {
          if (ts.isOmittedExpression(el) || ts.isSpreadElement(el)) return false;
          if (el.kind === ts.SyntaxKind.StringLiteral) return false;
          const t = resolveWasmType(ctx, ctx.checker.getTypeAtLocation(el));
          if (t.kind === "ref" || t.kind === "ref_null") {
            const ti = (t as { typeIdx: number }).typeIdx;
            return ti !== ctx.anyStrTypeIdx && ti !== ctx.nativeStrTypeIdx;
          }
          // f64 / i32 / externref / etc. — a non-string element.
          return true;
        });
        if (hasNonStringElem) {
          elemWasm = { kind: "externref" };
        }
      }
    }
  }
  // A spread contributes elements just like an explicit literal slot. In
  // published/untyped JavaScript its source is commonly `any`; selecting a
  // concrete vec from the first fixed element (`[boolean, ...anyValue]`) would
  // coerce every spread value through that primitive representation and can
  // also violate the enclosing callback's `any[]` result ABI. Preserve the
  // source values in the universal carrier, including the spread-first shape.
  if (hasDynamicOrCallableElement) {
    elemWasm = { kind: "externref" };
  }
  // (#2106 S0) `any[]` element tag-recovery. When the contextual element type is
  // `any`, the first-element heuristic above can pick a bare primitive ValType
  // (e.g. `[true]` → i32, because `boolean` lowers to i32 and the contextual-type
  // adoption at the ref branch never fires for a non-ref first element). The vec
  // is then built as `__vec_i32` and later coerced to the `any[]` externref vec
  // by Wasm KIND (`f64.convert_i32_s; __box_number`), so a boolean read back as
  // `a[0]` reports `typeof === "number"` / `"" + a[0] === "1"` — the JS tag is
  // lost. Booleans, mixed-primitive heterogeneity, and any non-string ref all
  // need the per-element JS-type-aware boxing that `compileExpression(el,
  // externref)` already performs (`__box_boolean` for bool, `__box_number` for
  // number, native-string for string — the same path the `a.push(true)` route
  // uses, which is already correct). Widen the element type to externref so each
  // element is boxed by its own static type at construction, not by Wasm kind
  // after the fact. Scoped strictly to `any` contextual elements: number[] /
  // string[] / struct[] literals are untouched (byte-identical).
  //
  // (#3244) EXTENDED to object-struct elements. `[{ x: 777 }]` in an `any` /
  // `Array<any>` context (`const a: any = [{ x: 777 }]`, `f([{ x: 777 }])` with
  // `f(a: any)`) infers a homogeneous element type `{ x: number }`, so the
  // first-element heuristic picks a CLOSED anon-struct carrier
  // (`__vec_<__anon_0>`). But the object literal itself, compiled in an `any`
  // context, is a DYNAMIC `$Object` (externref) — and the element store then
  // coerces `$Object → (ref null __anon_0)` via `ref.test`/`ref.cast`, which
  // FAILS (a `$Object` is not the closed struct) → the element is stored as
  // NULL. `a[0]` reads back null → `a[0].x` throws / reads NaN. Widening the
  // carrier to `externref` (exactly as the numeric case does) stores each object
  // element by its own dynamic rep, so the read-back + member dispatch work
  // identically to a heterogeneous `[1, { x: 777 }]` array (which already boxes
  // every element). Scoped, like the numeric widening, to an `any`/`Array<any>`
  // contextual type — a genuinely-typed `Iface[]` / `{x:number}[]` literal keeps
  // its closed-struct carrier byte-identical (and reads back correctly through
  // the #3244 `boxVecElementToExternref` arm when it later crosses the boundary).
  // NESTED-ARRAY (vec-struct) elements are EXCLUDED — they already read back via
  // the typed `__extern_get_idx` vec arm — so this only re-keys plain objects.
  const elemIsPlainObjectStructRef =
    // Standalone/nativeStrings only — the closed-struct-carrier + lossy
    // `$Object`→struct downcast is the STANDALONE array-build path (the host lane
    // uses `__js_array_new` + real JS values, already correct at 777). Gating
    // here keeps the host lane byte-identical (the numeric widenings above stay
    // ungated because they fix genuine any[]-boxing needed in both lanes).
    (ctx.standalone || ctx.nativeStrings) &&
    (elemWasm.kind === "ref" || elemWasm.kind === "ref_null") &&
    (() => {
      const ti = (elemWasm as { typeIdx: number }).typeIdx;
      if (ti < 0) return false;
      if (ti === ctx.anyStrTypeIdx || ti === ctx.nativeStrTypeIdx) return false; // strings keep their carrier
      const rt = ctx.mod.types[ti];
      if (rt?.kind !== "struct") return false;
      for (const v of ctx.vecTypeMap.values()) if (v === ti) return false; // exclude nested-array vec carriers
      return true;
    })();
  // (#4531) ESCAPE widening — the diff-sequences shape. A literal of closed
  // object structs (`const callbacks = [{ foundSubsequence, isCommon }]`)
  // whose value ESCAPES into an `any`/`unknown`-typed call argument crosses to
  // a consumer that mutates it dynamically: the consumer's
  // `callbacks.push({…})` builds an OPEN host `$Object` that can never
  // ref.test as the closed element struct, so the push is lost and
  // `callbacks[1]` reads null. When the escape is provable at the literal,
  // pick the universal externref element carrier up front — every element
  // (and every later push) then shares the open representation, and the
  // dynamic member reads both sides use already handle it. Applies to BOTH
  // lanes (the host lane is where the diff-sequences cluster lives); nested
  // vec elements and string carriers keep their representation exactly as the
  // #3244 predicate scopes them.
  const elemIsClosedStructRefAnyLane =
    (elemWasm.kind === "ref" || elemWasm.kind === "ref_null") &&
    (() => {
      const ti = (elemWasm as { typeIdx: number }).typeIdx;
      if (ti < 0) return false;
      if (ti === ctx.anyStrTypeIdx || ti === ctx.nativeStrTypeIdx) return false;
      const rt = ctx.mod.types[ti];
      if (rt?.kind !== "struct") return false;
      for (const v of ctx.vecTypeMap.values()) if (v === ti) return false;
      return true;
    })();
  if (!hasSpread && elemIsClosedStructRefAnyLane && arrayLiteralEscapeWidensToExternref(ctx, expr)) {
    elemWasm = { kind: "externref" };
  }
  if (!hasSpread && (elemWasm.kind === "i32" || elemWasm.kind === "f64" || elemIsPlainObjectStructRef)) {
    const ctxArrType = ctx.checker.getContextualType(expr);
    if (ctxArrType) {
      const ctxArrSym = (ctxArrType as ts.TypeReference).symbol ?? ctxArrType.symbol;
      if (ctxArrSym?.name === "Array" || ctxArrSym?.name === "ReadonlyArray") {
        const ctxElemType = ctx.checker.getTypeArguments(ctxArrType as ts.TypeReference)[0];
        if (ctxElemType && (ctxElemType.flags & ts.TypeFlags.Any) !== 0) {
          elemWasm = { kind: "externref" };
        }
      } else if ((ctxArrType.flags & ts.TypeFlags.Any) !== 0) {
        // (#3154) BARE-`any` context — an array literal passed directly to an
        // `any`-typed parameter (`f([1, void 0, 3])` with `f(a: any)`), or an
        // inner tuple of an `any[]` outer literal. The S0 widening above only
        // fires for `Array<any>` contextual types, so these literals kept the
        // first-element f64/i32 fast path: a `void 0` element became the sNaN
        // sentinel (reads back as a NaN *number*, `a[1] !== a[1]` self-compare
        // fails, `typeof` lies), and string/symbol/boolean elements were
        // dropped or number-coerced at CONSTRUCTION — unrecoverable at any
        // read site. This regressed 15 baseline-pass compareArray-cluster
        // tests when the test262 harness shims briefly moved to `any` params
        // (#3151 merge-group park, run 29175942933).
        //
        // Widen to externref-boxed elements — the SAME construction the
        // `Array<any>` context already uses, so each element is boxed by its
        // own static type (`__box_number` / `__box_boolean` / `__box_symbol` /
        // native string / `ref.null extern` for undefined) — but ONLY when the
        // literal is not purely numeric. A homogeneous number literal (the
        // overwhelmingly common `compareArray(x, [1, 2, 3])` shape) keeps the
        // f64 fast path byte-identical: its elements read back correctly
        // through the dynamic `any` path already, and NaN self-inequality on a
        // *genuine* NaN element is spec-correct (§7.2.16), not corruption.
        const allPlainNumbers = expr.elements.every((el) => {
          if (ts.isOmittedExpression(el) || _isUndefinedLike(el) || ts.isSpreadElement(el)) return false;
          // (#1930) Classify via the oracle's static JS-type helper rather than
          // a direct checker call, to satisfy the oracle-ratchet gate.
          return ctx.oracle.staticJsTypeOf(el) === "number";
        });
        if (!allPlainNumbers) {
          elemWasm = { kind: "externref" };
        }
      }
    }
  }
  // (#4293) An array-of-arrays cannot use the first inner vec as a closed
  // carrier when later inner arrays select a different element
  // representation. `[[0], [undefined]]` historically coerced the second
  // externref vec to the first f64 vec, turning undefined into numeric NaN
  // before any consumer ran. Normalize only proven heterogeneous nested
  // arrays to vec<externref>; homogeneous numeric matrices keep their compact
  // vec<f64> carrier.
  if (
    !hasSpread &&
    (elemWasm.kind === "ref" || elemWasm.kind === "ref_null") &&
    hasHeterogeneousNestedArrayCarriers(ctx, expr, firstElem)
  ) {
    const innerVecIdx = getOrRegisterVecType(ctx, "externref", { kind: "externref" });
    elemWasm = { kind: "ref_null", typeIdx: innerVecIdx };
  }
  // (#3543) Preserve the carrier that a nested heterogeneous literal ACTUALLY
  // builds in an `any` context. With `unionAnyRep` enabled, the outer literal's
  // first-element TS type `(string | number)[]` resolves to
  // `__vec_ref_<AnyValue>`. The inner literal's existing #2190b/#2106 writer,
  // however, correctly widens its mixed elements to canonical
  // `__vec_externref`. Compiling that inner value against the inferred outer
  // carrier immediately copies every externref element into `$AnyValue`; the
  // dynamic vec reader then externalizes the wrapper rather than its payload,
  // so numbers become NaN and native-string casts null-deref. The RTT arm order
  // is not involved: the correct AnyValue vec arm matches.
  //
  // Re-key only this proven writer/inference mismatch. Both literals normally
  // must be in a genuine any context, the inferred element must specifically
  // be a vec of AnyValue, and neither construction may contain a spread.
  //
  // A direct for-of subject with a binding default/nested pattern is the one
  // exception: `compileForOfArray` scopes `_forOfPreserveUndefElem` around that
  // subject, but the subject has no TypeScript contextual type. The inner
  // heterogeneous literal still widens to the canonical externref carrier,
  // so requiring an any contextual fact leaves the outer vec at AnyValue and
  // copies each element through the wrong representation (#4447).
  // Typed union matrices, homogeneous matrices, flat arrays, and the flag-off
  // lane remain byte-identical.
  const inferredInnerVec =
    elemWasm.kind === "ref" || elemWasm.kind === "ref_null" ? getVecInfo(ctx, elemWasm.typeIdx) : null;
  const forOfDstrCarrierWiden = (ctx as any)._forOfPreserveUndefElem === true;
  if (
    ctx.unionAnyRep &&
    !hasSpread &&
    ts.isArrayLiteralExpression(firstElem) &&
    !firstElem.elements.some(ts.isSpreadElement) &&
    ((arrayLiteralHasAnyElementContext(ctx, expr) && arrayLiteralHasAnyElementContext(ctx, firstElem)) ||
      forOfDstrCarrierWiden) &&
    inferredInnerVec &&
    (inferredInnerVec.elemType.kind === "ref" || inferredInnerVec.elemType.kind === "ref_null") &&
    inferredInnerVec.elemType.typeIdx === ctx.anyValueTypeIdx
  ) {
    const innerVecIdx = getOrRegisterVecType(ctx, "externref", { kind: "externref" });
    elemWasm = { kind: "ref_null", typeIdx: innerVecIdx };
  }
  if (forcedElementType !== undefined) elemWasm = forcedElementType;
  // (#2769) for-of over a direct array LITERAL whose binding pattern has an
  // element default / nested sub-pattern: the OUTER literal must not coerce an
  // inner `[undefined]` / `[hole]` array down to a numeric vec (the leaf
  // `undefined`/`void` maps to i32 → `resolveWasmType(undefined[])` = `__vec_i32`,
  // so the inner `[undefined]` — built fresh as `__vec_externref` — is COERCED to
  // `__vec_i32` → `__unbox_number` → `i32.trunc_sat_f64_s` → 0, destroying the
  // undefined identity at CONSTRUCTION; the vec-destructure then never fires the
  // default). When the scoped `_forOfPreserveUndefElem` flag is set (set by
  // compileForOfArray around the subject compile) AND the first element is an
  // array literal that carries undefined/void/hole, re-key the OUTER element type
  // to an externref vec so the inner undefined/$Hole survives to the EXISTING
  // wantUndefinedSentinel / __extern_is_undefined read path. ZERO read-path edits;
  // NO resolveWasmType change (that is what avoids the PR #2226 global-backing
  // regressions). The flag is tightly scoped (set→subject→clear), so unrelated
  // array literals are byte-identical.
  if (
    (ctx as any)._forOfPreserveUndefElem &&
    ts.isArrayLiteralExpression(firstElem) &&
    arrayLiteralIsUndefinedOrHoleOnly(firstElem)
  ) {
    const innerVecIdx = getOrRegisterVecType(ctx, "externref", { kind: "externref" });
    elemWasm = { kind: "ref_null", typeIdx: innerVecIdx };
  }
  elemKind = elemWasm.kind === "ref" || elemWasm.kind === "ref_null" ? `ref_${elemWasm.typeIdx}` : elemWasm.kind;
  const vecTypeIdx = getOrRegisterVecType(ctx, elemKind, elemWasm);
  const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
  if (arrTypeIdx < 0) {
    reportError(ctx, expr, "Array literal: invalid vec type");
    return null;
  }

  if (!hasSpread) {
    // No spread — use the fast array.new_fixed path, then wrap in vec struct
    for (const el of expr.elements) {
      // For holes and explicit undefined in f64 context, emit sNaN sentinel
      // so destructuring default checks trigger correctly (#1024).
      // (#4491 T11) The two are no longer the same sentinel: an ELISION is
      // absent (`HOLE_F64_BITS`), an explicit `undefined` element is present
      // and holds `undefined` (`UNDEF_F64_BITS`). They agree on every value
      // question — the read boundary maps hole→undef — and disagree on `in` /
      // `hasOwnProperty` / `Object.keys` / the HOF skip, which is the whole
      // point. Gated: without the pre-scan flag no marker forks, so a module
      // with no elision is byte-identical.
      if (elemWasm.kind === "f64" && _isUndefinedLike(el)) {
        const absent = ts.isOmittedExpression(el) && f64HolesActive(ctx);
        if (absent) ctx.f64HoleMarkerEmitted = true;
        fctx.body.push({ op: "i64.const", value: absent ? HOLE_F64_BITS : UNDEF_F64_BITS });
        fctx.body.push({ op: "f64.reinterpret_i64" });
      } else if (elemWasm.kind === "externref" && ts.isOmittedExpression(el)) {
        // (#2001 S1) An array-literal elision (`[1, , 3]`) in an `any[]` /
        // untyped (externref-element) vec is a genuine *hole* — store the
        // `$Hole` sentinel, NOT JS `undefined`. This is what makes a hole
        // distinguishable from an explicit `undefined` element so later HOFs
        // can honour the §23.1.3.* HasProperty hole-skip. An explicit
        // `undefined` literal is NOT a hole (`ts.isOmittedExpression` is false
        // for it) and keeps its `emitUndefined` lowering via the else branch.
        // Gated strictly on `externref` — typed number[]/boolean[] literals are
        // byte-identical (their elision keeps the element default / sNaN path).
        emitHoleSentinel(ctx, fctx);
      } else {
        // A heterogeneous object-literal array selects the universal
        // externref carrier above because its closed struct shapes are not
        // interchangeable. Keep construction in lockstep with that decision:
        // a closed struct merely wrapped as externref is opaque to the dynamic
        // property reads used by callback destructuring (`forEach(({x}) => …)`),
        // so every field would read as undefined. Build data-only literals as
        // open `$Object`s instead. The builder recursively applies the same
        // representation to nested data literals, while accessors, methods,
        // spreads, and computed keys retain their established lowering.
        const objectElement = elemWasm.kind === "externref" ? unwrapObjectLiteralElement(el) : null;
        const openObjectType =
          objectElement !== null && staticObjectLiteralDataKeys(ctx, objectElement) !== null
            ? compileObjectLiteralAsExternref(ctx, fctx, objectElement)
            : null;
        if (openObjectType === null) compileExpression(ctx, fctx, el, elemWasm);
      }
    }
    fctx.body.push({ op: "array.new_fixed", typeIdx: arrTypeIdx, length: expr.elements.length });
    // Store data array in temp local, then build vec struct
    const tmpData = allocLocal(fctx, `__arr_data_${fctx.locals.length}`, { kind: "ref", typeIdx: arrTypeIdx });
    fctx.body.push({ op: "local.set", index: tmpData });
    fctx.body.push({ op: "i32.const", value: expr.elements.length }); // length field (field 0)
    fctx.body.push({ op: "local.get", index: tmpData }); // data field (field 1)
    fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx }); // wrap in vec struct
    return { kind: "ref_null", typeIdx: vecTypeIdx };
  }

  // Has spread elements — compute total length, create array, then fill
  // Step 1: Compute total length and store spread sources in locals
  const spreadLocals: { local: number; elemIdx: number; srcVecTypeIdx: number }[] = [];
  const nonSpreadCount = expr.elements.filter((el) => !ts.isSpreadElement(el)).length;

  // Push the non-spread count as the initial length
  fctx.body.push({ op: "i32.const", value: nonSpreadCount });

  // For each spread source, compile it, store in local, and add its length
  for (let i = 0; i < expr.elements.length; i++) {
    const el = expr.elements[i]!;
    if (ts.isSpreadElement(el)) {
      // (#42) Spread of a standalone-native Set (`[...set]`). The subject lowers
      // to a `ref $Map` (a Set is a Map under the hood) whose field 0 is NOT a
      // $length, so the generic vec fallthrough below would read it as a length
      // (`i32.add expected i32, found struct.get` — invalid Wasm). Route it
      // through the same `emitCollectionIteratorVec` driver the for-of /
      // `.values()` paths use: a Set spreads its values (§24.2.3.*). It produces
      // a canonical externref `$Vec`; the fill loop (Step 3) coerces each
      // externref element to the result element type. (Bare `[...map]` spreads
      // `[k, v]` entry pairs — deferred to the entries-pair slice #2162/#9.)
      if (ctx.nativeStrings) {
        const subjType = ctx.checker.getTypeAtLocation(el.expression);
        const subjName = (subjType.symbol ?? subjType.aliasSymbol)?.name;
        if (subjName === "Set") {
          const matType = emitCollectionIteratorVec(ctx, fctx, el.expression, "values", /* isSet */ true);
          if (matType != null && matType !== VOID_RESULT && (matType.kind === "ref" || matType.kind === "ref_null")) {
            const matVecTypeIdx = matType.typeIdx;
            const srcLocal = allocLocal(fctx, `__spread_coll_${fctx.locals.length}`, matType);
            fctx.body.push({ op: "local.tee", index: srcLocal });
            fctx.body.push({ op: "struct.get", typeIdx: matVecTypeIdx, fieldIdx: 0 });
            fctx.body.push({ op: "i32.add" });
            spreadLocals.push({ local: srcLocal, elemIdx: i, srcVecTypeIdx: matVecTypeIdx });
            continue;
          }
          // Driver declined (non-native receiver) — fall through to the generic
          // path, which compiles the subject itself below.
        }
      }
      const srcType = compileExpression(ctx, fctx, el.expression);
      if (!srcType) continue;
      // (#2169) Spread of a Wasm-native generator (`[...g()]`). The subject is a
      // ref to the generator state struct, NOT a __vec — without this it fell
      // into the generic vec branch below (struct.get field 0 read as $length →
      // garbage-length array of defaults / host-import leak). Drain the
      // generator into an f64 vec via the native resume loop, then treat it as a
      // normal materialized vec spread (same shape as the externref path).
      const genInfo = nativeGeneratorInfoForForOfSubject(ctx, srcType);
      if (genInfo) {
        // (#2864 F1) Drain into a vec whose element type matches the generator's
        // carrier: f64 for numeric (unchanged) or externref for the boxed-any
        // carrier (object / mixed yields). The native-string carrier is handled
        // by the dedicated string-spread arm below, so only f64 / externref reach
        // here; anything else keeps the f64 default and is skipped by the guard.
        const genElemKind = genInfo.elemValType.kind === "externref" ? "externref" : "f64";
        const genVecTypeIdx = getOrRegisterVecType(ctx, genElemKind);
        const genArrTypeIdx = getArrTypeIdxFromVec(ctx, genVecTypeIdx);
        if (vecTypeIdx !== genVecTypeIdx) {
          // Result element type doesn't match the generator's carrier (mixed
          // literal whose first-element heuristic picked another type) — copying
          // into that array would be invalid Wasm. Conservative skip.
          fctx.body.push({ op: "drop" });
          continue;
        }
        // Stack: [running-length(i32), genState]. emitNativeGeneratorToVec
        // consumes genState and leaves (ref $vec_f64).
        emitNativeGeneratorToVec(ctx, fctx, genInfo, srcType, genVecTypeIdx, genArrTypeIdx);
        const srcLocal = allocLocal(fctx, `__spread_gen_${fctx.locals.length}`, {
          kind: "ref_null",
          typeIdx: genVecTypeIdx,
        });
        fctx.body.push({ op: "local.tee", index: srcLocal });
        fctx.body.push({ op: "struct.get", typeIdx: genVecTypeIdx, fieldIdx: 0 });
        fctx.body.push({ op: "i32.add" });
        spreadLocals.push({ local: srcLocal, elemIdx: i, srcVecTypeIdx: genVecTypeIdx });
        continue;
      }
      if (
        (srcType.kind === "ref" || srcType.kind === "ref_null") &&
        ctx.nativeStrings &&
        ctx.anyStrTypeIdx >= 0 &&
        (srcType.typeIdx === ctx.anyStrTypeIdx || srcType.typeIdx === ctx.nativeStrTypeIdx)
      ) {
        // (#1470) Spread of a native string — previously this fell into the
        // generic vec-struct branch below, whose getArrTypeIdxFromVec lookup
        // fails for the string struct and silently contributed NOTHING (the
        // result array stayed empty). Materialize the §22.1.5.1 code-point
        // vec in pure Wasm instead.
        const { funcIdx: toCharVecIdx, vecTypeIdx: nstrVecTypeIdx } = ensureStrToCharVecHelper(ctx);
        if (vecTypeIdx !== nstrVecTypeIdx) {
          // Result element type is not string (mixed literal like
          // `[1, ..."ab"]` whose first-element heuristic picked f64) —
          // copying string refs into that array would be invalid Wasm.
          // Preserve the pre-existing skip behavior for this rare shape.
          fctx.body.push({ op: "drop" });
          continue;
        }
        if (srcType.kind === "ref_null") {
          fctx.body.push({ op: "ref.as_non_null" });
        }
        fctx.body.push({ op: "call", funcIdx: toCharVecIdx });
        const srcLocal = allocLocal(fctx, `__spread_str_${fctx.locals.length}`, {
          kind: "ref_null",
          typeIdx: nstrVecTypeIdx,
        });
        fctx.body.push({ op: "local.tee", index: srcLocal });
        fctx.body.push({ op: "struct.get", typeIdx: nstrVecTypeIdx, fieldIdx: 0 });
        fctx.body.push({ op: "i32.add" });
        spreadLocals.push({ local: srcLocal, elemIdx: i, srcVecTypeIdx: nstrVecTypeIdx });
        continue;
      }
      if (srcType.kind === "externref") {
        // #1514 — Spread of a JS iterable (Set, Map, generator, Array, etc.)
        // arriving as externref. Materialize into a wasm vec matching the
        // result's element type by iterating __extern_length / __extern_get,
        // then treat as a normal vec spread. Without this, `[...realJsSet]`
        // silently produced an empty array because the externref branch was
        // dropped.
        const externLocal = allocLocal(fctx, `__spread_extern_${fctx.locals.length}`, { kind: "externref" });
        fctx.body.push({ op: "local.set", index: externLocal });
        const matVecInfo = getVecInfo(ctx, vecTypeIdx);
        if (!matVecInfo) continue;
        // (#3100 S5) Standalone: protocol-materialize FIRST (custom-iterable
        // drain / indexable passthrough) so the indexed reads below stay right.
        emitStandaloneIterableMaterialize(ctx, fctx, externLocal);
        // Array spread is a strict GetIterator consumer. Unlike general ABI
        // externref→vec coercion, a missing/null/non-callable @@iterator must
        // throw instead of falling back to array-like indexing (#3368).
        const matInstrs = buildVecFromExternref(ctx, fctx, externLocal, vecTypeIdx, matVecInfo, true);
        for (const instr of matInstrs) fctx.body.push(instr);
        const srcLocal = allocLocal(fctx, `__spread_mat_${fctx.locals.length}`, {
          kind: "ref_null",
          typeIdx: vecTypeIdx,
        });
        fctx.body.push({ op: "local.tee", index: srcLocal });
        fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
        fctx.body.push({ op: "i32.add" });
        spreadLocals.push({ local: srcLocal, elemIdx: i, srcVecTypeIdx: vecTypeIdx });
        continue;
      }
      if (srcType.kind !== "ref" && srcType.kind !== "ref_null") {
        // The compiled expression left a value on the stack — drop it so we
        // don't corrupt the running total (i32) that sits underneath.
        fctx.body.push({ op: "drop" });
        continue;
      }
      // (#2033) Spread of a user-defined iterable — an object literal / value
      // whose struct carries a `[Symbol.iterator]()` returning a Wasm-native
      // iterator struct. Without this it fell into the generic vec-struct path
      // below, which reads `struct.get field 0` (the iterator-closure externref)
      // as an i32 length → `i32.add expected i32, found externref` (invalid
      // wasm). Spec §12.2.5.3: spread is a GetIterator consumer, same as for-of.
      // Drain the iterator protocol into a vec of the result element type, then
      // treat it as a normal materialized vec spread (same shape as the
      // externref / generator paths above).
      if (isCustomIterable(ctx, srcType)) {
        const matVecInfo = getVecInfo(ctx, vecTypeIdx);
        if (matVecInfo) {
          const iterableLocal = allocLocal(fctx, `__spread_citer_src_${fctx.locals.length}`, srcType);
          fctx.body.push({ op: "local.set", index: iterableLocal });
          if (emitDrainCustomIterableToVec(ctx, fctx, iterableLocal, srcType, vecTypeIdx)) {
            const srcLocal = allocLocal(fctx, `__spread_citer_${fctx.locals.length}`, {
              kind: "ref_null",
              typeIdx: vecTypeIdx,
            });
            fctx.body.push({ op: "local.tee", index: srcLocal });
            fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
            fctx.body.push({ op: "i32.add" });
            spreadLocals.push({ local: srcLocal, elemIdx: i, srcVecTypeIdx: vecTypeIdx });
            continue;
          }
          // Drain unavailable — the value is consumed into iterableLocal; fall
          // through with nothing contributed (drop is implicit, no stack value).
          continue;
        }
        // No fillable vec — drop the source and skip.
        fctx.body.push({ op: "drop" });
        continue;
      }
      // (#3369) A remaining GC reference is not necessarily a `$Vec`. In
      // particular, test262 builds iterables post-hoc from an empty object via
      // `iter[Symbol.iterator] = fn` / Object.defineProperty. Its closed struct
      // has no fields, so the former unconditional `struct.get 0` below emitted
      // invalid Wasm. For every non-Vec reference, cross the externref boundary
      // and use the same strict GetIterator materialization as an externref
      // spread. This preserves getter/call/step/value abrupt completions and
      // throws for a missing or non-callable iterator.
      const staticSrcVecInfo = getVecInfo(ctx, srcType.typeIdx);
      if (!staticSrcVecInfo) {
        coerceType(ctx, fctx, srcType, { kind: "externref" });
        const externLocal = allocLocal(fctx, `__spread_ref_extern_${fctx.locals.length}`, {
          kind: "externref",
        });
        fctx.body.push({ op: "local.set", index: externLocal });
        const matVecInfo = getVecInfo(ctx, vecTypeIdx);
        if (!matVecInfo) continue;
        emitStandaloneIterableMaterialize(ctx, fctx, externLocal);
        const matInstrs = buildVecFromExternref(ctx, fctx, externLocal, vecTypeIdx, matVecInfo, true);
        for (const instr of matInstrs) fctx.body.push(instr);
        const srcLocal = allocLocal(fctx, `__spread_ref_mat_${fctx.locals.length}`, {
          kind: "ref_null",
          typeIdx: vecTypeIdx,
        });
        fctx.body.push({ op: "local.tee", index: srcLocal });
        fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
        fctx.body.push({ op: "i32.add" });
        spreadLocals.push({ local: srcLocal, elemIdx: i, srcVecTypeIdx: vecTypeIdx });
        continue;
      }
      // (#1749 CPR) Array spread `[...arr]` must honor an overridden
      // `Array.prototype[Symbol.iterator]` / `.values` — §12.2.5.3 spread is a
      // GetIterator consumer, the same observation boundary the four
      // destructuring contexts already drive (#1719). When the override brand
      // is set AND a closure was captured, drive the override on the
      // spread-source vec to obtain the override-produced iterator externref,
      // then drain that iterator step-by-step via `__iterator_next` into a
      // growable WasmGC vec of the result element type. The override generator
      // compiles to a WasmGC generator whose `.next` is reached through the
      // wasm-struct dispatch (`__call_next` / `__sget_*`), so it must be stepped
      // through `__iterator_next` (the only host import that resolves a
      // wasm-struct iterator) — `__array_from_iter` / `__iterator_rest` only
      // walk JS-callable `.next` and silently yield an empty array here. The
      // gate (`arrayIteratorMaybeOverridden && override-captured`) is false in
      // the common case, so override-free spread stays byte-identical (the vec
      // fast path below). The brand fires only here at the observation
      // boundary, so internal array iterations inside the override body stay on
      // the typed-vec fast path — no re-entrancy.
      const overrideGlobalIdx = arrayIteratorOverrideGlobalIdx(ctx);
      if (ctx.arrayIteratorMaybeOverridden && overrideGlobalIdx !== undefined) {
        const matVecInfo = getVecInfo(ctx, vecTypeIdx);
        const nextIdx = ensureLateImport(
          ctx,
          "__iterator_next",
          [{ kind: "externref" }],
          [{ kind: "i32" }, { kind: "externref" }],
        );
        flushLateImportShifts(ctx, fctx);
        if (matVecInfo && nextIdx !== undefined) {
          const elemType = matVecInfo.elemType;
          // Growable backing array (doubling capacity) + running length.
          const capLocal = allocLocal(fctx, `__spread_ovr_cap_${fctx.locals.length}`, { kind: "i32" });
          const lenLocal = allocLocal(fctx, `__spread_ovr_len_${fctx.locals.length}`, { kind: "i32" });
          const dataLocal = allocLocal(fctx, `__spread_ovr_data_${fctx.locals.length}`, {
            kind: "ref",
            typeIdx: arrTypeIdx,
          });
          const doneLocal = allocLocal(fctx, `__spread_ovr_done_${fctx.locals.length}`, { kind: "i32" });
          const valLocal = allocLocal(fctx, `__spread_ovr_val_${fctx.locals.length}`, { kind: "externref" });
          const growLocal = allocLocal(fctx, `__spread_ovr_grow_${fctx.locals.length}`, {
            kind: "ref",
            typeIdx: arrTypeIdx,
          });
          // Build the element-coercion template FIRST: `coerceType` may register
          // late imports (e.g. `__unbox_number` for an f64 vec). Those imports
          // shift function indices, so they MUST be registered + flushed BEFORE
          // `emitArrayProtoIteratorDrive` emits its `call __drive_proto_iterator`
          // — otherwise the drive's funcIdx is shifted out from under the
          // already-emitted call and the drive resolves to the wrong function
          // (returning a null iterator → empty spread). (#1749)
          const valueCoerce = collectInstrs(fctx, () => {
            fctx.body.push({ op: "local.get", index: valLocal });
            coerceType(ctx, fctx, { kind: "externref" }, elemType);
          });
          flushLateImportShifts(ctx, fctx);
          // Re-read `__iterator_next`'s funcIdx: any import added by the coerce
          // template above shifted it (the `nextIdx` captured before the
          // valueCoerce build is stale). The shift patched emitted calls, but we
          // haven't emitted the loop's `call` yet — use the post-flush index.
          const drainNextIdx = ctx.funcMap.get("__iterator_next") ?? nextIdx;
          // Stack: [vec-ref]. Drive the override → iterator externref local.
          const iterLocal = emitArrayProtoIteratorDrive(ctx, fctx, overrideGlobalIdx);
          // cap = 4; data = new array[cap]; len = 0.
          fctx.body.push({ op: "i32.const", value: 4 });
          fctx.body.push({ op: "local.set", index: capLocal });
          fctx.body.push({ op: "local.get", index: capLocal });
          fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
          fctx.body.push({ op: "local.set", index: dataLocal });
          fctx.body.push({ op: "i32.const", value: 0 });
          fctx.body.push({ op: "local.set", index: lenLocal });
          // Grow when len == cap: cap *= 2; grow = new array[cap];
          // array.copy grow[0..len] = data[0..len]; data = grow.
          const growInstrs = collectInstrs(fctx, () => {
            fctx.body.push({ op: "local.get", index: capLocal });
            fctx.body.push({ op: "i32.const", value: 2 });
            fctx.body.push({ op: "i32.mul" });
            fctx.body.push({ op: "local.set", index: capLocal });
            fctx.body.push({ op: "local.get", index: capLocal });
            fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
            fctx.body.push({ op: "local.set", index: growLocal });
            fctx.body.push({ op: "local.get", index: growLocal });
            fctx.body.push({ op: "i32.const", value: 0 });
            fctx.body.push({ op: "local.get", index: dataLocal });
            fctx.body.push({ op: "i32.const", value: 0 });
            fctx.body.push({ op: "local.get", index: lenLocal });
            fctx.body.push({ op: "array.copy", dstTypeIdx: arrTypeIdx, srcTypeIdx: arrTypeIdx });
            fctx.body.push({ op: "local.get", index: growLocal });
            fctx.body.push({ op: "local.set", index: dataLocal });
          });
          // loop body: (done, val) = __iterator_next(iter); if done break;
          // if len == cap grow; data[len] = coerce(val); len++.
          const loopBody: Instr[] = [];
          loopBody.push({ op: "local.get", index: iterLocal });
          loopBody.push({ op: "call", funcIdx: drainNextIdx });
          loopBody.push({ op: "local.set", index: valLocal }); // value (top)
          loopBody.push({ op: "local.set", index: doneLocal }); // done (below)
          loopBody.push({ op: "local.get", index: doneLocal });
          loopBody.push({ op: "br_if", depth: 1 }); // done → break
          loopBody.push({ op: "local.get", index: lenLocal });
          loopBody.push({ op: "local.get", index: capLocal });
          loopBody.push({ op: "i32.ge_s" });
          loopBody.push({ op: "if", blockType: { kind: "empty" }, then: growInstrs, else: [] });
          loopBody.push({ op: "local.get", index: dataLocal });
          loopBody.push({ op: "local.get", index: lenLocal });
          for (const instr of valueCoerce) loopBody.push(instr);
          loopBody.push({ op: "array.set", typeIdx: arrTypeIdx });
          loopBody.push({ op: "local.get", index: lenLocal });
          loopBody.push({ op: "i32.const", value: 1 });
          loopBody.push({ op: "i32.add" });
          loopBody.push({ op: "local.set", index: lenLocal });
          loopBody.push({ op: "br", depth: 0 }); // continue
          // Guard the whole drain on a non-null iterator (an unresolved-override
          // drive returns null — degrade to an empty contribution, no trap).
          const drainInstrs = collectInstrs(fctx, () => {
            fctx.body.push({
              op: "block",
              blockType: { kind: "empty" },
              body: [{ op: "loop", blockType: { kind: "empty" }, body: loopBody }],
            });
          });
          fctx.body.push({ op: "local.get", index: iterLocal });
          fctx.body.push({ op: "ref.is_null" });
          fctx.body.push({ op: "i32.eqz" });
          fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: drainInstrs, else: [] });
          // Build the contributed vec { len, data } and accumulate its length
          // into the running total, exactly like the other spread sources.
          fctx.body.push({ op: "local.get", index: lenLocal });
          fctx.body.push({ op: "local.get", index: dataLocal });
          fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
          const srcLocal = allocLocal(fctx, `__spread_ovr_${fctx.locals.length}`, {
            kind: "ref_null",
            typeIdx: vecTypeIdx,
          });
          fctx.body.push({ op: "local.tee", index: srcLocal });
          fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
          fctx.body.push({ op: "i32.add" });
          spreadLocals.push({ local: srcLocal, elemIdx: i, srcVecTypeIdx: vecTypeIdx });
          continue;
        }
      }
      const srcVecTypeIdx = (srcType as { typeIdx: number }).typeIdx;
      const srcLocal = allocLocal(fctx, `__spread_src_${fctx.locals.length}`, srcType);
      fctx.body.push({ op: "local.tee", index: srcLocal });
      fctx.body.push({ op: "struct.get", typeIdx: srcVecTypeIdx, fieldIdx: 0 }); // get length from vec
      fctx.body.push({ op: "i32.add" }); // accumulate total length
      spreadLocals.push({ local: srcLocal, elemIdx: i, srcVecTypeIdx });
    }
  }

  // Step 2: Create the result backing array with computed length, default-initialized
  const resultArrType: ValType = { kind: "ref", typeIdx: arrTypeIdx };
  fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
  const resultLocal = allocLocal(fctx, `__spread_result_${fctx.locals.length}`, resultArrType);
  fctx.body.push({ op: "local.set", index: resultLocal });

  // Step 3: Fill the array — track current write index
  const writeIdx = allocLocal(fctx, `__spread_wi_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: writeIdx });

  for (let i = 0; i < expr.elements.length; i++) {
    const el = expr.elements[i]!;
    if (ts.isSpreadElement(el)) {
      // Copy all elements from spread source using a loop
      const spreadInfo = spreadLocals.find((s) => s.elemIdx === i);
      if (!spreadInfo) continue;

      const srcArrTypeIdx = getArrTypeIdxFromVec(ctx, spreadInfo.srcVecTypeIdx);
      if (srcArrTypeIdx < 0) continue;
      const readIdx = allocLocal(fctx, `__spread_ri_${fctx.locals.length}`, { kind: "i32" });
      fctx.body.push({ op: "i32.const", value: 0 });
      fctx.body.push({ op: "local.set", index: readIdx });

      // (#42) When the spread source's element type differs from the result
      // element type, the raw `array.get → array.set` below would store a
      // mismatched type (invalid Wasm). This happens when a standalone
      // collection iterator (`[...set.values()]`, `[...map.entries()]`) — whose
      // canonical `$Vec` holds externref entries — is spread into a numeric
      // result vec. Capture a per-element coercion template (e.g. externref →
      // f64 via the standalone `__unbox_number`, which has a pure-Wasm body in
      // `nativeStrings` mode — no host import) and splice it between the read and
      // the write. `coerceType` may register late imports, so build the template
      // (which flushes them) BEFORE emitting the loop. When src/dst element types
      // already match, the template is empty and the copy stays byte-identical.
      const srcVecInfo = getVecInfo(ctx, spreadInfo.srcVecTypeIdx);
      const dstVecInfo = getVecInfo(ctx, vecTypeIdx);
      let elemCoerce: Instr[] = [];
      if (srcVecInfo && dstVecInfo && !valTypesMatch(srcVecInfo.elemType, dstVecInfo.elemType)) {
        elemCoerce = collectInstrs(fctx, () => {
          coerceType(ctx, fctx, srcVecInfo.elemType, dstVecInfo.elemType);
        });
      }

      // loop: while readIdx < srcVec.length
      const loopBody: Instr[] = [];
      // Condition: readIdx >= srcVec.length → break
      loopBody.push({ op: "local.get", index: readIdx });
      loopBody.push({ op: "local.get", index: spreadInfo.local });
      loopBody.push({ op: "struct.get", typeIdx: spreadInfo.srcVecTypeIdx, fieldIdx: 0 }); // get length from vec
      loopBody.push({ op: "i32.ge_s" });
      loopBody.push({ op: "br_if", depth: 1 }); // break out of block
      // result[writeIdx] = coerce(src.data[readIdx])
      loopBody.push({ op: "local.get", index: resultLocal });
      loopBody.push({ op: "local.get", index: writeIdx });
      loopBody.push({ op: "local.get", index: spreadInfo.local });
      loopBody.push({ op: "struct.get", typeIdx: spreadInfo.srcVecTypeIdx, fieldIdx: 1 }); // get data from vec
      loopBody.push({ op: "local.get", index: readIdx });
      loopBody.push({ op: "array.get", typeIdx: srcArrTypeIdx });
      for (const instr of elemCoerce) loopBody.push(instr);
      loopBody.push({ op: "array.set", typeIdx: arrTypeIdx });
      // writeIdx++; readIdx++
      loopBody.push({ op: "local.get", index: writeIdx });
      loopBody.push({ op: "i32.const", value: 1 });
      loopBody.push({ op: "i32.add" });
      loopBody.push({ op: "local.set", index: writeIdx });
      loopBody.push({ op: "local.get", index: readIdx });
      loopBody.push({ op: "i32.const", value: 1 });
      loopBody.push({ op: "i32.add" });
      loopBody.push({ op: "local.set", index: readIdx });
      loopBody.push({ op: "br", depth: 0 }); // continue loop

      fctx.body.push({
        op: "block",
        blockType: { kind: "empty" },
        body: [{ op: "loop", blockType: { kind: "empty" }, body: loopBody }],
      });
    } else {
      // Non-spread element: result[writeIdx] = el; writeIdx++
      fctx.body.push({ op: "local.get", index: resultLocal });
      fctx.body.push({ op: "local.get", index: writeIdx });
      if (elemWasm.kind === "externref" && ts.isOmittedExpression(el)) {
        // (#2001 S1) Hole interleaved with spreads (`[...a, , b]`) in an
        // externref-element vec → store the `$Hole` sentinel, matching the
        // no-spread path. Gated on externref; typed vecs are untouched.
        emitHoleSentinel(ctx, fctx);
      } else if (elemWasm.kind === "f64" && ts.isOmittedExpression(el) && f64HolesActive(ctx)) {
        ctx.f64HoleMarkerEmitted = true;
        // (#4491 T11) Same for the f64 carrier: the spread path must agree with
        // the `array.new_fixed` path above about what an elision stores.
        fctx.body.push({ op: "i64.const", value: HOLE_F64_BITS });
        fctx.body.push({ op: "f64.reinterpret_i64" });
      } else {
        compileExpression(ctx, fctx, el, elemWasm);
      }
      fctx.body.push({ op: "array.set", typeIdx: arrTypeIdx });
      fctx.body.push({ op: "local.get", index: writeIdx });
      fctx.body.push({ op: "i32.const", value: 1 });
      fctx.body.push({ op: "i32.add" });
      fctx.body.push({ op: "local.set", index: writeIdx });
    }
  }

  // Wrap the result backing array in a vec struct
  // Stack: totalLen (= writeIdx), data ref → struct.new
  fctx.body.push({ op: "local.get", index: writeIdx }); // length field (field 0)
  fctx.body.push({ op: "local.get", index: resultLocal }); // data field (field 1)
  fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx }); // wrap in vec struct
  return { kind: "ref_null", typeIdx: vecTypeIdx };
}

/**
 * Compile Array(n) or Array(a,b,c) function calls (non-new).
 * Array(n) creates a sparse array of length n (all slots undefined/default).
 * Array(a,b,c) creates [a, b, c].
 * These have identical semantics to new Array(...).
 */
export function compileArrayConstructorCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
): ValType | null {
  const args = expr.arguments;

  // Determine element type from contextual type or expression type
  const ctxType = ctx.checker.getContextualType(expr);
  const exprType = ctxType ?? ctx.checker.getTypeAtLocation(expr);

  // Infer element type
  let elemWasm: ValType;
  const rawTypeArgs = ctx.checker.getTypeArguments(exprType as ts.TypeReference);
  const elemTsType = rawTypeArgs?.[0];
  const untypedElem = !elemTsType || (elemTsType.flags & ts.TypeFlags.Any) !== 0;
  // (#2809 PROTOTYPE — partial; see issue) Keep this builtin's vec representation
  // in lockstep with the `Array<undefined>`/`Array<void>` → externref rule in
  // `resolveWasmType`'s Array branch (#2806 site #3). Without this,
  // `Array(undefined, undefined)` builds an i32 vec here (scalar
  // `resolveWasmType(undefined)` = i32) while every CONSUMER resolves the value's
  // `Array<undefined>` type to an externref vec — a type/value mismatch that
  // mis-reads `.length` and trips `array.new_fixed` validation. This fixes the
  // non-`new` `Array(undefined, …)` case (test262 S15.4.1) and leaves numeric
  // arrays untouched. NOTE: `new Array(…)` (new-super.ts), sparse `[,,,]` holes,
  // and `.sort()` still need the SAME alignment — that spread is the
  // representation-scale decision #2809 carves for the architect.
  const pureUndefinedVoidElem =
    !!elemTsType &&
    (elemTsType.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !== 0 &&
    (elemTsType.flags & ~(ts.TypeFlags.Undefined | ts.TypeFlags.Void)) === 0;
  if (pureUndefinedVoidElem) {
    elemWasm = { kind: "externref" };
  } else if (!untypedElem) {
    elemWasm = resolveWasmType(ctx, elemTsType!);
  } else if (args.length === 1 && !ts.isSpreadElement(args[0]!)) {
    // #1998: `Array(n)` with an untyped element type is a *sparse* array of `n`
    // holes (§23.1.1.1 step 4) — every slot is `undefined`. An f64 backing
    // (`array.new_default`) defaults those holes to `0`, so `Array(3).join(",")`
    // wrongly rendered "0,0,0". Mirror the `new Array(n)` path (new-super.ts):
    // back untyped sparse arrays with externref, whose default is `ref.null`,
    // which `join`/`toString` render as "" (§23.1.3.18 step 7.c/d) → ",,".
    elemWasm = { kind: "externref" };
  } else {
    // Default to f64 for untyped dense arrays (`Array()`, `Array(a, b, c)`).
    elemWasm = { kind: "f64" };
  }

  const elemKind =
    elemWasm.kind === "ref" || elemWasm.kind === "ref_null"
      ? `ref_${(elemWasm as { typeIdx: number }).typeIdx}`
      : elemWasm.kind;
  const vecTypeIdx = getOrRegisterVecType(ctx, elemKind, elemWasm);
  const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
  if (arrTypeIdx < 0) {
    reportError(ctx, expr, "Array(): invalid vec type");
    return null;
  }

  if (args.length === 0) {
    // Array() → empty array
    fctx.body.push({ op: "i32.const", value: 0 }); // length = 0
    fctx.body.push({ op: "i32.const", value: 0 }); // size for array.new_default
    fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
    fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
    return { kind: "ref_null", typeIdx: vecTypeIdx };
  }

  if (args.length === 1) {
    // §23.1.1.1 step 5: a single NON-Number argument is an element, not a
    // length — `Array(null)` / `Array("1")` / `Array(new Number(0))` build the
    // one-element array `[arg]` (test262 S15.4.2.2_A2.3_T1–T4; the call and
    // `new` forms behave identically). Provably-non-number args (static tag ≠
    // number) take this path; `mixed` (any-typed) keeps length behavior.
    const argTag = ctx.oracle.staticJsTypeOf(args[0]!);
    if (argTag !== "number" && argTag !== "mixed" && !ts.isSpreadElement(args[0]!)) {
      const oneVecIdx =
        elemWasm.kind === "externref" ? vecTypeIdx : getOrRegisterVecType(ctx, "externref", { kind: "externref" });
      const oneArrIdx = getArrTypeIdxFromVec(ctx, oneVecIdx);
      compileExpression(ctx, fctx, args[0]!, { kind: "externref" });
      fctx.body.push({ op: "array.new_fixed", typeIdx: oneArrIdx, length: 1 });
      const oneData = allocLocal(fctx, `__arr_data_${fctx.locals.length}`, { kind: "ref", typeIdx: oneArrIdx });
      fctx.body.push({ op: "local.set", index: oneData });
      fctx.body.push({ op: "i32.const", value: 1 });
      fctx.body.push({ op: "local.get", index: oneData });
      fctx.body.push({ op: "struct.new", typeIdx: oneVecIdx });
      return { kind: "ref_null", typeIdx: oneVecIdx };
    }
    // Array(n) → sparse array of length n with default values.
    // #2000 — §23.1.1.1 step 4.b: when the single argument is a Number it is a
    // length, and `len !== ToUint32(len)` must throw a RangeError ("Invalid
    // array length"). Without this guard `Array(3.5)` / `Array(-1)` truncated
    // to a dense array or trapped at array.new_default. Emit the integer/range
    // check around the (already correct) length-array build.
    const lenLocal = allocLocal(fctx, `__arr_len_f64_${fctx.locals.length}`, { kind: "f64" });
    compileExpression(ctx, fctx, args[0]!, { kind: "f64" });
    fctx.body.push({ op: "local.tee", index: lenLocal });
    // valid = (n >= 0) & (n <= 4294967295) & (floor(n) === n)
    //   n >= 0
    fctx.body.push({ op: "f64.const", value: 0 });
    fctx.body.push({ op: "f64.ge" });
    //   n <= 2^32 - 1
    fctx.body.push({ op: "local.get", index: lenLocal });
    fctx.body.push({ op: "f64.const", value: 4294967295 });
    fctx.body.push({ op: "f64.le" });
    fctx.body.push({ op: "i32.and" });
    //   floor(n) === n  (integer check; also rejects NaN since NaN !== NaN)
    fctx.body.push({ op: "local.get", index: lenLocal });
    fctx.body.push({ op: "local.get", index: lenLocal });
    fctx.body.push({ op: "f64.floor" });
    fctx.body.push({ op: "f64.eq" });
    fctx.body.push({ op: "i32.and" });
    // if (!valid) throw RangeError
    fctx.body.push({ op: "i32.eqz" });
    const rangeErrMsg = "RangeError: Invalid array length";
    addStringConstantGlobal(ctx, rangeErrMsg);
    const tagIdx = ensureExnTag(ctx);
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [...stringConstantExternrefInstrs(ctx, rangeErrMsg), { op: "throw", tagIdx }],
    });
    // Valid length: build the array of that size.
    fctx.body.push({ op: "local.get", index: lenLocal });
    fctx.body.push({ op: "i32.trunc_sat_f64_s" });
    const sizeLocal = allocLocal(fctx, `__arr_size_${fctx.locals.length}`, { kind: "i32" });
    fctx.body.push({ op: "local.tee", index: sizeLocal });
    fctx.body.push({ op: "local.get", index: sizeLocal });
    fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
    fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
    return { kind: "ref_null", typeIdx: vecTypeIdx };
  }

  // Array(a, b, c) → [a, b, c]
  for (const arg of args) {
    compileExpression(ctx, fctx, arg, elemWasm);
  }
  fctx.body.push({ op: "array.new_fixed", typeIdx: arrTypeIdx, length: args.length });
  const tmpData = allocLocal(fctx, `__arr_data_${fctx.locals.length}`, { kind: "ref", typeIdx: arrTypeIdx });
  fctx.body.push({ op: "local.set", index: tmpData });
  fctx.body.push({ op: "i32.const", value: args.length });
  fctx.body.push({ op: "local.get", index: tmpData });
  fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
  return { kind: "ref_null", typeIdx: vecTypeIdx };
}

// Register delegate in shared.ts so index.ts can call resolveComputedKeyExpression
// without importing literals.ts directly (which imports index.ts → cycle).
registerResolveComputedKeyExpression(resolveComputedKeyExpression);
