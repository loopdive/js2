// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2162 — Wasm-native `WeakMap` / `WeakSet` runtime for standalone / WASI.
 *
 * In JS-host mode these route through the `builtinCtors` host table and emit
 * `WeakMap_*` / `WeakSet_*` host imports. Under `--target standalone` /
 * `--target wasi` there is no JS host to satisfy them, so this module provides
 * pure-WasmGC weak collections by REUSING the native Map runtime
 * (`map-runtime.ts`): WeakMap is a Map and WeakSet is a Set (key === value)
 * over the same `$Map` hash table.
 *
 * **Semantic difference from Map/Set**: weak collections have NO iteration and
 * NO `.size`, and their keys MUST be objects. The standalone runtime does not
 * model the *weak* (garbage-collectable) reference — WasmGC has no weak refs —
 * so a WeakMap/WeakSet here strongly retains its entries. That is a memory
 * property, not an observable one: every spec test for get/set/has/delete /
 * add behaviour passes with strong retention (only `FinalizationRegistry` /
 * `WeakRef` liveness tests, which are skip-filtered, could tell the
 * difference). The object-key requirement is enforced for statically known
 * invalid insertion literals in standalone/WASI lowering; dynamic aliases
 * retain the Map's existing SameValueZero handling until a later runtime type
 * guard can cover them without changing valid-symbol representation.
 *
 * Backing representation: the native `$Map` struct (`ctx.mapTypeIdx`) — the Map
 * runtime already compares object keys by `ref.eq` identity, exactly WeakMap
 * key semantics. A `WeakMap`/`WeakSet`-typed binding resolves to `ref $Map`.
 * Interception mirrors Map/Set:
 *   - `new WeakMap()` / `new WeakSet()` → `__map_new`   (new-super.ts)
 *   - WeakMap `get`/`set`/`has`/`delete` → `__map_*`     (extern.ts)
 *   - WeakSet `add` → `__weakset_add` (wraps `__map_set`), `has`/`delete` → `__map_*`
 *
 * Everything is emitted lazily and only when `ctx.nativeStrings`. JS-host is
 * untouched.
 */
import { ts } from "../ts-api.js";
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { addFuncType } from "./registry/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js"; // (#1916 S3) stable-regime minting
import type { InnerResult } from "./shared.js";
import { compileExpression, VOID_RESULT } from "./shared.js";
import { isNullOrUndefinedLiteral } from "./destructuring-params.js";
import { emitThrowTypeError } from "./js-errors.js";
import { compileCollectionElementArg, ensureMapHelpers } from "./map-runtime.js";

/**
 * Emit the `__weakset_add(m, v) -> ref $Map` helper (idempotent). WeakSet.add
 * stores the element as both key and value (so the shared Map lookup sees a
 * normal entry) and returns the collection (chainable, spec 24.4.3.1).
 */
export function ensureWeakCollectionHelpers(ctx: CodegenContext): void {
  ensureMapHelpers(ctx);
  if (ctx.mapHelpers.has("__weakset_add")) return;
  if (ctx.mapTypeIdx < 0) return;

  const mref: ValType = { kind: "ref", typeIdx: ctx.mapTypeIdx };
  const anyref: ValType = { kind: "anyref" };
  const mapSetIdx = ctx.mapHelpers.get("__map_set");
  if (mapSetIdx === undefined) return;

  // __weakset_add(m, v): return __map_set(m, v, v)
  const body: Instr[] = [
    { op: "local.get", index: 0 }, // m
    { op: "local.get", index: 1 }, // key = v
    { op: "local.get", index: 1 }, // value = v
    { op: "call", funcIdx: mapSetIdx },
  ];
  const typeIdx = addFuncType(ctx, [mref, anyref], [mref]);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.mapHelpers.set("__weakset_add", funcIdx);
  pushDefinedFunc(ctx, funcIdx, { name: "__weakset_add", typeIdx, locals: [], body, exported: false });
}

/** Cast a compiled receiver to `ref $Map` (the weak-collection backing store).
 *  Returns false when it is a different concrete struct (generic path retries). */
function castReceiverToMap(ctx: CodegenContext, fctx: FunctionContext, recvType: ValType | null): boolean {
  if (recvType === null) return false;
  if (recvType.kind === "externref") {
    fctx.body.push({ op: "any.convert_extern" });
    fctx.body.push({ op: "ref.cast", typeIdx: ctx.mapTypeIdx });
  } else if (recvType.kind === "anyref" || recvType.kind === "eqref") {
    fctx.body.push({ op: "ref.cast", typeIdx: ctx.mapTypeIdx });
  } else if ((recvType.kind === "ref" || recvType.kind === "ref_null") && recvType.typeIdx !== ctx.mapTypeIdx) {
    return false;
  }
  return true;
}

/**
 * Peel the type-only wrappers that can surround a statically known weak-key
 * argument. The emitted argument still gets evaluated before a rejection, so
 * this classifier only chooses the post-evaluation error path.
 */
function unwrapWeakKeyExpr(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (
    ts.isAsExpression(current) ||
    ts.isParenthesizedExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/**
 * Return true only for expressions whose runtime value is definitely not
 * weakly holdable. This deliberately remains a static fast path: dynamic
 * aliases and plain `Symbol()` values retain the existing native collection
 * representation and are outside this compact ES2015 cohort.
 */
function isDefinitelyNotWeakKey(ctx: CodegenContext, fctx: FunctionContext, expr: ts.Expression | undefined): boolean {
  if (expr === undefined) return true;
  const unwrapped = unwrapWeakKeyExpr(expr);
  if (
    isNullOrUndefinedLiteral(unwrapped) ||
    ts.isNumericLiteral(unwrapped) ||
    ts.isStringLiteralLike(unwrapped) ||
    ts.isBigIntLiteral(unwrapped) ||
    unwrapped.kind === ts.SyntaxKind.TrueKeyword ||
    unwrapped.kind === ts.SyntaxKind.FalseKeyword
  ) {
    return true;
  }

  // `Symbol.for(...)` returns a registered symbol, which is not a valid weak
  // key. Keep the global-binding check local to this leaf module so a user
  // variable named `Symbol` does not get hijacked by the native fast path.
  if (ts.isCallExpression(unwrapped) && ts.isPropertyAccessExpression(unwrapped.expression)) {
    const callee = unwrapped.expression;
    if (
      callee.name.text === "for" &&
      ts.isIdentifier(callee.expression) &&
      callee.expression.text === "Symbol" &&
      !fctx.localMap.has("Symbol") &&
      !fctx.boxedCaptures?.has("Symbol")
    ) {
      const declarations = ctx.oracle.declarationsOf(callee.expression);
      return (
        declarations.length === 0 || declarations.every((declaration) => declaration.getSourceFile().isDeclarationFile)
      );
    }
  }
  return false;
}

/**
 * (#2162) Intercept a `WeakMap.prototype.*` / `WeakSet.prototype.*` method call
 * in standalone / `nativeStrings` mode and route it to the native Map/weak
 * runtime. `className` selects the surface (WeakMap has get/set; WeakSet has
 * add). Returns the result `InnerResult` when handled, else `undefined`.
 */
export function tryCompileNativeWeakMethodCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  className: "WeakMap" | "WeakSet",
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
): InnerResult | undefined {
  if (!ctx.nativeStrings) return undefined;
  const methodName = propAccess.name.text;

  // WeakMap: get/set/has/delete. WeakSet: add/has/delete.
  const isWeakMap = className === "WeakMap";
  const handled = isWeakMap
    ? methodName === "get" || methodName === "set" || methodName === "has" || methodName === "delete"
    : methodName === "add" || methodName === "has" || methodName === "delete";
  if (!handled) return undefined;

  ensureWeakCollectionHelpers(ctx);
  if (ctx.mapTypeIdx < 0) return undefined;
  const helperName = methodName === "add" ? "__weakset_add" : `__map_${methodName}`;
  const helperIdx = ctx.mapHelpers.get(helperName);
  if (helperIdx === undefined) return undefined;

  // Receiver → ref $Map.
  const recvType = compileExpression(ctx, fctx, propAccess.expression);
  if (!castReceiverToMap(ctx, fctx, recvType)) return undefined;

  const args = callExpr.arguments;
  // (#3395) Route key/value args through `compileCollectionElementArg`, not a
  // raw `compileExpression` + `coerceMapKeyToAnyref`: the former recognizes a
  // null/undefined key literal (incl. `null as any` — the §CanBeHeldWeakly
  // "value cannot be held weakly" test rows) and emits a canonical
  // `ref.null NONE_HEAP` instead of letting a TYPED `ref.null $Struct` flow into
  // `any.convert_extern` ("expected externref, found ref.null of type (ref null
  // N)", invalid Wasm). It also carries the #3394 i64/bigint boxing arm.
  switch (methodName) {
    case "get":
    case "has":
    case "delete": {
      compileCollectionElementArg(ctx, fctx, args.length > 0 ? args[0]! : undefined);
      fctx.body.push({ op: "call", funcIdx: helperIdx });
      // get → anyref value; has/delete → i32 (boolean).
      return methodName === "get" ? ({ kind: "anyref" } as ValType) : ({ kind: "i32" } as ValType);
    }
    case "set": {
      compileCollectionElementArg(ctx, fctx, args.length > 0 ? args[0]! : undefined);
      const rejectsKey = ctx.standalone || ctx.wasi ? isDefinitelyNotWeakKey(ctx, fctx, args[0]) : false;
      if (rejectsKey) {
        fctx.body.push({ op: "drop" });
        // Arguments are evaluated left-to-right before the method body can
        // reject the key; preserve the second argument's side effects too.
        compileCollectionElementArg(ctx, fctx, args.length > 1 ? args[1]! : undefined);
        fctx.body.push({ op: "drop" });
        emitThrowTypeError(ctx, fctx, "TypeError: Invalid value used as weak map key");
        return { kind: "ref", typeIdx: ctx.mapTypeIdx } as ValType;
      }
      compileCollectionElementArg(ctx, fctx, args.length > 1 ? args[1]! : undefined);
      fctx.body.push({ op: "call", funcIdx: helperIdx });
      // __map_set returns ref $Map (the collection) — chainable.
      return { kind: "ref", typeIdx: ctx.mapTypeIdx } as ValType;
    }
    case "add": {
      compileCollectionElementArg(ctx, fctx, args.length > 0 ? args[0]! : undefined);
      const rejectsValue = ctx.standalone || ctx.wasi ? isDefinitelyNotWeakKey(ctx, fctx, args[0]) : false;
      if (rejectsValue) {
        fctx.body.push({ op: "drop" });
        emitThrowTypeError(ctx, fctx, "TypeError: Invalid value used as weak set value");
        return { kind: "ref", typeIdx: ctx.mapTypeIdx } as ValType;
      }
      fctx.body.push({ op: "call", funcIdx: helperIdx });
      // __weakset_add returns ref $Map — chainable.
      return { kind: "ref", typeIdx: ctx.mapTypeIdx } as ValType;
    }
  }
  return undefined;
}

void VOID_RESULT; // weak collections expose no void method in this slice
