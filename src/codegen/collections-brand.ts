// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#3171) Reflective `X.prototype.METHOD.call(recv, …)` /
 * `inst.METHOD.call(recv, …)` dispatch for ALL FOUR keyed collections
 * (Map / Set / WeakMap / WeakSet) with the spec receiver brand check —
 * generalizing the #2604 Set-only reflective dispatch that used to live in
 * set-runtime.ts.
 *
 * Spec §24.1.3.* / §24.2.4.* / §24.3.3.* / §24.4.3.* step 1/2: "If `this` does
 * not have a [[MapData]] / [[SetData]] / [[WeakMapData]] / [[WeakSetData]]
 * internal slot, throw a TypeError". Two layers:
 *
 *   1. **Struct brand** — the receiver must be the native `$Map` backing
 *      struct (`ref.test`, non-trapping → catchable TypeError). Rejects
 *      primitives, null/undefined, plain objects, arrays, `X.prototype`, …
 *   2. **COLLECTION_KIND tag** (map-runtime.ts) — all four collections SHARE
 *      the `$Map` hash table, so `Map.prototype.get.call(new Set())` passes
 *      the struct test; the immutable `kind` field stamped by `__map_new`
 *      separates the brands (`does-not-have-*-internal-slot-{map,set,weakmap,
 *      weakset}` rows).
 *
 * The brand gate is the shared `emitReceiverBrandCheck` (receiver-brand.ts) —
 * the SAME preamble the set-algebra argument validation (#2607, kind-lenient)
 * and the Date receiver check (#3174) parameterize.
 *
 * On a brand HIT the call routes to the same native helpers the direct
 * statically-typed paths use (`__map_*` / `__set_add` / `__weakset_add`, the
 * eager keys/values/entries vec materialization, the native forEach drive), so
 * a correct receiver behaves identically through `.call`. Direct dispatch
 * (extern.ts / property-access.ts) is untouched — static receiver types make
 * the brand check statically true there.
 *
 * `.apply` (packed args) is deferred, matching #2604.
 */
import { ts } from "../ts-api.js";
import { COLLECTION_KIND } from "./builtin-brands.js";
import type { ValType } from "../ir/types.js";
import {
  compileCollectionGetOrInsert,
  emitSetAlgebraAnyArgDispatch,
  ensureSetAlgebraAnyDispatch,
  isSetAlgebraMethod,
} from "./collections-es2025.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import {
  MAP_LAYOUT,
  compileCollectionElementArg,
  emitCollectionIteratorVec,
  ensureMapHelpers,
  tryCompileNativeCollectionForEach,
} from "./map-runtime.js";
import { emitThrowTypeError } from "./expressions/helpers.js";
import { emitReceiverBrandCheck, type ReceiverBrandSpec } from "./receiver-brand.js";
import { ensureSetAlgebraHelpers } from "./set-algebra.js";
import { ensureSetHelpers } from "./set-runtime.js";
import type { InnerResult } from "./shared.js";
import { VOID_RESULT, compileExpression } from "./shared.js";
import { ensureWeakCollectionHelpers } from "./weak-collections-runtime.js";

type CollectionClass = "Map" | "Set" | "WeakMap" | "WeakSet";

/** Prototype methods each collection's reflective dispatch owns. (#3172 added
 *  the ES2025 layer: Map/WeakMap getOrInsert(Computed), Set set-algebra.) */
const COLLECTION_METHODS: Record<CollectionClass, ReadonlySet<string>> = {
  Map: new Set([
    "get",
    "set",
    "has",
    "delete",
    "clear",
    "forEach",
    "keys",
    "values",
    "entries",
    "getOrInsert",
    "getOrInsertComputed",
  ]),
  Set: new Set([
    "add",
    "has",
    "delete",
    "clear",
    "forEach",
    "keys",
    "values",
    "entries",
    "union",
    "intersection",
    "difference",
    "symmetricDifference",
    "isSubsetOf",
    "isSupersetOf",
    "isDisjointFrom",
  ]),
  WeakMap: new Set(["get", "set", "has", "delete", "getOrInsert", "getOrInsertComputed"]),
  WeakSet: new Set(["add", "has", "delete"]),
};

const KIND_OF: Record<CollectionClass, number> = {
  Map: COLLECTION_KIND.MAP,
  Set: COLLECTION_KIND.SET,
  WeakMap: COLLECTION_KIND.WEAKMAP,
  WeakSet: COLLECTION_KIND.WEAKSET,
};

/** The `[[XData]]` receiver brand for one collection class: `$Map` struct +
 *  matching COLLECTION_KIND tag. Exported for #3172 (set-algebra receivers). */
export function collectionBrandSpec(ctx: CodegenContext, cls: CollectionClass): ReceiverBrandSpec {
  return {
    message: `TypeError: Method ${cls}.prototype.* called on incompatible receiver`,
    structTypeIdx: ctx.mapTypeIdx,
    kindField: { fieldIdx: MAP_LAYOUT.M_KIND, accept: [KIND_OF[cls]] },
  };
}

/**
 * Is `closure` syntactically `X.prototype.METHOD` (X ∈ the four collection
 * ctors) or `<expr>.METHOD` where `<expr>` is statically typed as one of the
 * four lib collections? Returns the matched class + method. Mirrors #2604's
 * `setMethodClosureName`, widened to all four classes.
 */
function collectionMethodTarget(
  ctx: CodegenContext,
  closure: ts.Expression,
): { cls: CollectionClass; method: string } | undefined {
  let e: ts.Expression = closure;
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e)) {
    e = (e as ts.ParenthesizedExpression | ts.AsExpression | ts.NonNullExpression).expression;
  }
  // (#3172) Value-erased closure variable: `const union = Set.prototype.union;
  // union.call(recv, …)` (the `require-internal-slot.js` harness shape). Trace
  // the identifier back to its single initializer and match THAT — one level,
  // mirroring calls.ts's resolveVarInitializer data-flow trace.
  if (ts.isIdentifier(e)) {
    const init = resolveVarInitializerLocal(ctx, e);
    if (init === undefined) return undefined;
    e = init;
    while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e)) {
      e = (e as ts.ParenthesizedExpression | ts.AsExpression | ts.NonNullExpression).expression;
    }
  }
  if (!ts.isPropertyAccessExpression(e)) return undefined;
  const method = e.name.text;
  // Unwrap parens/`as`/non-null on the OBJECT too, so `(Map.prototype as any)
  // .getOrInsert.call(…)` (the untyped-ES2025-method cast idiom) still matches.
  let obj: ts.Expression = e.expression;
  while (ts.isParenthesizedExpression(obj) || ts.isAsExpression(obj) || ts.isNonNullExpression(obj)) {
    obj = (obj as ts.ParenthesizedExpression | ts.AsExpression | ts.NonNullExpression).expression;
  }
  // `X.prototype.METHOD`
  if (
    ts.isPropertyAccessExpression(obj) &&
    obj.name.text === "prototype" &&
    ts.isIdentifier(obj.expression) &&
    obj.expression.text in COLLECTION_METHODS
  ) {
    const cls = obj.expression.text as CollectionClass;
    if (COLLECTION_METHODS[cls].has(method)) return { cls, method };
    return undefined;
  }
  // `<collectionExpr>.METHOD` where the expression is statically a lib
  // collection. (#1930) Resolved through the oracle (`declaredNameOf` — the
  // ratchet-sanctioned way to read the declared type-symbol name).
  const symName = ctx.oracle.declaredNameOf(obj);
  if (symName !== undefined && symName in COLLECTION_METHODS) {
    const cls = symName as CollectionClass;
    if (COLLECTION_METHODS[cls].has(method)) return { cls, method };
  }
  return undefined;
}

/**
 * Cheap syntactic predicate (NO codegen): does `expr` match a reflective
 * collection-method `.call` shape this module dispatches? The caller
 * (calls.ts) uses it to gate an `addUnionImports` BEFORE invoking
 * {@link tryCompileCollectionReflectiveCall} — the arg-boxing (`__box_number`)
 * the dispatch emits must be registered up-front, since adding it mid-body
 * would shift indices (#2604).
 */
export function isCollectionReflectiveCallShape(ctx: CodegenContext, expr: ts.CallExpression): boolean {
  if (!ctx.nativeStrings) return false;
  if (!ts.isPropertyAccessExpression(expr.expression)) return false;
  const dispatch = expr.expression;
  if (dispatch.name.text !== "call") return false;
  return collectionMethodTarget(ctx, dispatch.expression) !== undefined;
}

/**
 * Compile a reflective collection-method `.call`. Returns the result
 * `InnerResult` when handled, or `undefined` to fall through to the generic
 * path (JS-host mode, non-collection closure, unsupported form).
 */
export function tryCompileCollectionReflectiveCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
): InnerResult | undefined {
  if (!ctx.nativeStrings) return undefined;
  if (!ts.isPropertyAccessExpression(expr.expression)) return undefined;
  const dispatch = expr.expression; // `<closure>.call`
  if (dispatch.name.text !== "call") return undefined; // .apply deferred
  const target = collectionMethodTarget(ctx, dispatch.expression);
  if (target === undefined) return undefined;
  const { cls, method } = target;

  // Register the class's native runtime (idempotent).
  if (cls === "Map") ensureMapHelpers(ctx);
  else if (cls === "Set") ensureSetHelpers(ctx);
  else ensureWeakCollectionHelpers(ctx);
  if (ctx.mapTypeIdx < 0) return undefined;

  const brand = collectionBrandSpec(ctx, cls);
  const callArgs = expr.arguments;
  const recvExpr = callArgs.length > 0 ? callArgs[0]! : undefined;

  // `.call()` with no receiver → `this` is undefined → unconditional brand
  // TypeError. Uniform for every method: throw, then a null.extern sentinel
  // keeps the (unreachable) expression result well-typed.
  if (recvExpr === undefined) {
    emitThrowTypeError(ctx, fctx, brand.message);
    fctx.body.push({ op: "ref.null.extern" });
    return { kind: "externref" } as ValType;
  }

  // (#3172) getOrInsert / getOrInsertComputed (Map + WeakMap): the shared
  // emplace compiler with the brand-checked receiver from arg0.
  if (method === "getOrInsert" || method === "getOrInsertComputed") {
    return compileCollectionGetOrInsert(
      ctx,
      fctx,
      recvExpr,
      callArgs[1],
      callArgs[2],
      method === "getOrInsertComputed",
      /* weakKeys */ cls === "WeakMap",
      brand,
    );
  }

  // (#3172) Set-algebra (union/…/isDisjointFrom): brand-check the receiver,
  // then the runtime any-dispatcher handles the argument (native fast lane /
  // set-LIKE GetSetRecord lane / TypeError). Dispatcher is ensured BEFORE any
  // instruction is baked (#1719 discipline).
  if (isSetAlgebraMethod(method)) {
    ensureSetAlgebraHelpers(ctx);
    // Bail (clean, nothing emitted) when the dispatcher can't be built.
    if (ensureSetAlgebraAnyDispatch(ctx, method) === undefined) return undefined;
    const recvType2 = compileExpression(ctx, fctx, recvExpr);
    emitReceiverBrandCheck(ctx, fctx, recvType2, brand); // leaves (ref $Map)
    const argType = callArgs[1] !== undefined ? compileExpression(ctx, fctx, callArgs[1]) : null;
    return emitSetAlgebraAnyArgDispatch(ctx, fctx, method, argType);
  }

  // forEach: shared native drive with the brand-checked receiver from arg0 and
  // the callback from arg1. Bails (undefined) when the callback is not a
  // compilable closure form — the generic path then keeps legacy behaviour.
  if (method === "forEach") {
    const inner = unwrapToPropertyAccess(dispatch.expression);
    if (inner === undefined) return undefined;
    return tryCompileNativeCollectionForEach(ctx, fctx, inner, expr, /* isSet */ cls === "Set", {
      recvExpr,
      cbArg: callArgs[1],
      brand,
    });
  }

  // keys/values/entries: eager vec materialization with the brand-checked
  // receiver (same producer contract as the direct path).
  if (method === "keys" || method === "values" || method === "entries") {
    return emitCollectionIteratorVec(ctx, fctx, recvExpr, method, /* isSet */ cls === "Set", brand);
  }

  // Data methods → the shared `$Map` helpers.
  const helperName = method === "add" ? (cls === "WeakSet" ? "__weakset_add" : "__set_add") : `__map_${method}`;
  const helperIdx = ctx.mapHelpers.get(helperName);
  if (helperIdx === undefined) return undefined;

  const recvType = compileExpression(ctx, fctx, recvExpr);
  emitReceiverBrandCheck(ctx, fctx, recvType, brand); // leaves (ref $Map)

  switch (method) {
    case "add": {
      // (#2606 Bug A) null/undefined-literal element → canonical ref.null NONE_HEAP.
      compileCollectionElementArg(ctx, fctx, callArgs[1]);
      fctx.body.push({ op: "call", funcIdx: helperIdx });
      return { kind: "ref", typeIdx: ctx.mapTypeIdx } as ValType;
    }
    case "get":
    case "has":
    case "delete": {
      compileCollectionElementArg(ctx, fctx, callArgs[1]);
      fctx.body.push({ op: "call", funcIdx: helperIdx });
      // get → anyref value; has/delete → i32 (boolean).
      return method === "get" ? ({ kind: "anyref" } as ValType) : ({ kind: "i32" } as ValType);
    }
    case "set": {
      compileCollectionElementArg(ctx, fctx, callArgs[1]);
      compileCollectionElementArg(ctx, fctx, callArgs[2]);
      fctx.body.push({ op: "call", funcIdx: helperIdx });
      // __map_set returns ref $Map (the collection) — chainable.
      return { kind: "ref", typeIdx: ctx.mapTypeIdx } as ValType;
    }
    case "clear": {
      fctx.body.push({ op: "call", funcIdx: helperIdx });
      return VOID_RESULT;
    }
  }
  return undefined;
}

/**
 * (#3172) Resolve a variable's single initializer (mirrors calls.ts's
 * `resolveVarInitializer`). Uses the raw checker's symbol resolution — the
 * oracle exposes type FACTS, not declaration nodes (preauthorized in
 * scripts/oracle-ratchet-baseline.json).
 */
function resolveVarInitializerLocal(ctx: CodegenContext, ident: ts.Identifier): ts.Expression | undefined {
  try {
    const sym = ctx.checker.getSymbolAtLocation(ident);
    const decl = sym?.valueDeclaration;
    if (!decl || !ts.isVariableDeclaration(decl) || !decl.initializer) return undefined;
    return decl.initializer;
  } catch {
    return undefined;
  }
}

/** Unwrap parens/`as`/non-null down to the `X.prototype.METHOD` property access. */
function unwrapToPropertyAccess(closure: ts.Expression): ts.PropertyAccessExpression | undefined {
  let e: ts.Expression = closure;
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e)) {
    e = (e as ts.ParenthesizedExpression | ts.AsExpression | ts.NonNullExpression).expression;
  }
  return ts.isPropertyAccessExpression(e) ? e : undefined;
}
