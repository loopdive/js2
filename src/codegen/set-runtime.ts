import type { Instr, ValType } from "../ir/types.js";
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2162 — Wasm-native `Set` runtime for standalone / WASI targets.
 *
 * In JS-host mode `new Set()` and every method call route through the
 * `builtinCtors` host table and `ctx.externClasses`, emitting `Set_new` /
 * `Set_add` / … host imports. Under `--target standalone` / `--target wasi`
 * there is no JS host to satisfy those imports, so this module provides a
 * pure-WasmGC Set by REUSING the native Map runtime (`map-runtime.ts`): a Set
 * is a Map whose every entry has `value === key`. The `$Map` struct, ordered
 * hash table, SameValueZero key equality, and tombstone deletion are all
 * shared — only `add` (store `(v, v)`) is new.
 *
 * Backing representation: the native `$Map` struct (`ctx.mapTypeIdx`). A
 * `Set`-typed binding therefore resolves to `ref $Map` (see `resolveWasmType`),
 * exactly like `Map`. Interception mirrors the Map sites:
 *   - `new Set()`  → `__map_new`            (new-super.ts)
 *   - `s.add(v)`   → `__set_add(m, v)`       (this module; wraps `__map_set`)
 *   - `s.has(v)`   → `__map_has(m, v)`
 *   - `s.delete(v)`→ `__map_delete(m, v)`
 *   - `s.clear()`  → `__map_clear(m)`
 *   - `s.size`     → `__map_size(m)`
 *
 * Everything is emitted lazily and only when the native-collections path is
 * active (`ctx.nativeStrings`). The JS-host path is untouched.
 *
 * Slice 1 covers number/string/object elements with
 * new/add/has/delete/clear/size. Iteration (`forEach`, `for-of`,
 * `new Set(iterable)`, `keys`/`values`/`entries`) and ES2025 set-algebra
 * (`union`/`intersection`/…) are follow-up slices.
 */
import { ts } from "../ts-api.js";
import { allocTempLocal, releaseTempLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { emitThrowTypeError } from "./expressions/helpers.js";
import {
  coerceSetArgToAnyref,
  compileCollectionElementArg,
  compileNativeCollectionIterator,
  ensureMapHelpers,
  tryCompileNativeCollectionForEach,
} from "./map-runtime.js";
import { addFuncType } from "./registry/types.js";
import type { InnerResult } from "./shared.js";
import { VOID_RESULT, compileExpression } from "./shared.js";

/** Set.prototype methods whose `[[SetData]]` brand-check + native dispatch this
 *  module owns (the data + iteration methods; set-algebra lives in set-algebra.ts). */
const SET_BRAND_METHODS = new Set(["add", "has", "delete", "clear", "forEach", "entries", "keys", "values"]);

/**
 * Emit the `__set_add(m, v) -> ref $Map` helper (idempotent). `Set.add` stores
 * the element as both key and value so the shared Map lookup/iteration sees a
 * normal entry; the return value is the map itself (Set.add is chainable and
 * returns the Set, spec 24.2.3.1).
 */
export function ensureSetHelpers(ctx: CodegenContext): void {
  ensureMapHelpers(ctx);
  if (ctx.mapHelpers.has("__set_add")) return;
  if (ctx.mapTypeIdx < 0) return;

  const mref: ValType = { kind: "ref", typeIdx: ctx.mapTypeIdx };
  const anyref: ValType = { kind: "anyref" };
  const mapSetIdx = ctx.mapHelpers.get("__map_set");
  if (mapSetIdx === undefined) return;

  // __set_add(m, v): return __map_set(m, v, v)
  const body: Instr[] = [
    { op: "local.get", index: 0 }, // m
    { op: "local.get", index: 1 }, // key = v
    { op: "local.get", index: 1 }, // value = v
    { op: "call", funcIdx: mapSetIdx } as Instr,
  ];
  const typeIdx = addFuncType(ctx, [mref, anyref], [mref]);
  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.mapHelpers.set("__set_add", funcIdx);
  ctx.mod.functions.push({
    name: "__set_add",
    typeIdx,
    locals: [],
    body,
    exported: false,
  });
}

/**
 * Cast a compiled receiver expression to `ref $Map` (the Set backing store).
 * Returns false when the receiver is a different concrete struct (so the
 * generic extern/host path can try). Mirrors the Map receiver-cast logic.
 */
function castReceiverToMap(ctx: CodegenContext, fctx: FunctionContext, recvType: ValType | null): boolean {
  if (recvType === null) return false;
  if (recvType.kind === "externref") {
    fctx.body.push({ op: "any.convert_extern" } as Instr);
    fctx.body.push({ op: "ref.cast", typeIdx: ctx.mapTypeIdx } as Instr);
  } else if (recvType.kind === "anyref" || recvType.kind === "eqref") {
    fctx.body.push({ op: "ref.cast", typeIdx: ctx.mapTypeIdx } as Instr);
  } else if ((recvType.kind === "ref" || recvType.kind === "ref_null") && recvType.typeIdx !== ctx.mapTypeIdx) {
    return false; // wrong struct — not our Set
  }
  return true;
}

/**
 * (#2604) `[[SetData]]` brand-check for a reflectively-invoked Set method
 * receiver (`Set.prototype.METHOD.call(recv, …)` / `inst.METHOD.call(recv, …)`).
 * Consumes the just-compiled receiver value (`recvType` describes what is on the
 * stack) and leaves a non-null `(ref $Map)` — the validated backing struct — on
 * the stack.
 *
 * Spec 24.2.3.* step "If S does not have a [[SetData]] internal slot, throw a
 * TypeError": uses a NON-TRAPPING `ref.test $Map` (0/1, never traps on
 * null/primitive/wrong-struct) then branches — a miss throws a *catchable*
 * `TypeError` (NOT `ref.cast`, which would trap `illegal cast`, which test262
 * `assert.throws(TypeError, …)` does not accept). On a hit the value is
 * `ref.cast`-ed (safe — the test passed) to `(ref $Map)`.
 *
 * NOTE: a real `Map`/`WeakSet` is ALSO `$Map`-backed and passes `ref.test $Map`;
 * distinguishing Set from Map/Weak by struct alone is not possible without a
 * kind tag (the `does-not-have-setdata-internal-slot-{map,weakset}.js` sub-rows,
 * a documented stretch — #2604). The primitive / plain-object / array / null
 * rows (the bulk) flip here.
 */
export function emitSetBrandCheck(ctx: CodegenContext, fctx: FunctionContext, recvType: ValType | null): void {
  // Normalise the receiver to an anyref so `ref.test`/`ref.cast` apply uniformly
  // across externref / ref-struct / primitive-typed receivers.
  if (recvType === null) {
    // A statically void/never receiver — emit a null anyref so the test misses.
    fctx.body.push({ op: "ref.null", typeIdx: -1 } as unknown as Instr);
  } else if (recvType.kind === "externref") {
    fctx.body.push({ op: "any.convert_extern" } as Instr);
  } else if (recvType.kind === "i32" || recvType.kind === "f64" || recvType.kind === "i64") {
    // A primitive scalar receiver (`Set.prototype.add.call(0, …)` etc.) can never
    // be the backing struct — drop it and throw unconditionally.
    fctx.body.push({ op: "drop" } as Instr);
    emitThrowTypeError(ctx, fctx, "TypeError: Method Set.prototype.* called on incompatible receiver");
    // After the throw the stack is polymorphic; push a null $Map sentinel so the
    // (unreached) downstream call typechecks.
    fctx.body.push({ op: "ref.null", typeIdx: ctx.mapTypeIdx } as Instr);
    return;
  }
  // Receiver is now an anyref (or already a ref/eqref subtype) on the stack.
  const recvTmp = allocTempLocal(fctx, { kind: "anyref" } as ValType);
  fctx.body.push({ op: "local.tee", index: recvTmp } as Instr);
  fctx.body.push({ op: "ref.test", typeIdx: ctx.mapTypeIdx } as Instr);
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [],
    else: [],
  } as Instr);
  // Build the throw into the else arm via a temporary body swap so the late-import
  // shift in emitThrowTypeError patches the right buffer.
  const ifInstr = fctx.body[fctx.body.length - 1] as unknown as { else: Instr[] };
  const savedBody = fctx.body;
  fctx.body = ifInstr.else;
  emitThrowTypeError(ctx, fctx, "TypeError: Method Set.prototype.* called on incompatible receiver");
  fctx.body = savedBody;
  // Hit: cast the saved receiver to the concrete backing struct.
  fctx.body.push({ op: "local.get", index: recvTmp } as Instr);
  fctx.body.push({ op: "ref.cast", typeIdx: ctx.mapTypeIdx } as Instr);
  releaseTempLocal(fctx, recvTmp);
}

/**
 * (#2162) Intercept a `Set.prototype.*` method call in standalone /
 * `nativeStrings` mode and route it to the WasmGC-native Set/Map runtime.
 * Returns the result `InnerResult` when handled, or `undefined` to let the
 * generic extern/host path proceed (JS-host mode, or unsupported methods).
 *
 * Receiver and arguments are compiled here.
 */
export function tryCompileNativeSetMethodCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
): InnerResult | undefined {
  if (!ctx.nativeStrings) return undefined;
  const methodName = propAccess.name.text;

  // forEach drives a callback over the entries vector (24.2.3.6) — for a Set the
  // (value, key, set) callback gets value === key. Shares the Map helper.
  if (methodName === "forEach") {
    ensureSetHelpers(ctx);
    return tryCompileNativeCollectionForEach(ctx, fctx, propAccess, callExpr, /* isSet */ true);
  }

  // keys()/values() materialize a canonical externref $Vec — for a Set both yield
  // the element (24.2.3.*). `entries()` (the `[v, v]`-pair projection) needs the
  // `__iterator` pair consumer, deferred to a #2162 follow-up — it falls through.
  if (methodName === "keys" || methodName === "values") {
    ensureSetHelpers(ctx);
    return compileNativeCollectionIterator(ctx, fctx, propAccess, callExpr, methodName, /* isSet */ true);
  }

  const handled = methodName === "add" || methodName === "has" || methodName === "delete" || methodName === "clear";
  if (!handled) return undefined;

  ensureSetHelpers(ctx);
  if (ctx.mapTypeIdx < 0) return undefined;
  const helperName = methodName === "add" ? "__set_add" : `__map_${methodName}`;
  const helperIdx = ctx.mapHelpers.get(helperName);
  if (helperIdx === undefined) return undefined;

  // Receiver → ref $Map.
  const recvType = compileExpression(ctx, fctx, propAccess.expression);
  if (!castReceiverToMap(ctx, fctx, recvType)) return undefined;

  const args = callExpr.arguments;
  switch (methodName) {
    case "add": {
      // (#2606 Bug A) null/undefined-literal element → canonical ref.null
      // NONE_HEAP (else the typed ref-null fails the externref coercion).
      compileCollectionElementArg(ctx, fctx, args[0]);
      fctx.body.push({ op: "call", funcIdx: helperIdx });
      // __set_add returns ref $Map (the set) — chainable.
      return { kind: "ref", typeIdx: ctx.mapTypeIdx } as ValType;
    }
    case "has":
    case "delete": {
      compileCollectionElementArg(ctx, fctx, args[0]);
      fctx.body.push({ op: "call", funcIdx: helperIdx });
      // has/delete → i32 (boolean).
      return { kind: "i32" } as ValType;
    }
    case "clear": {
      fctx.body.push({ op: "call", funcIdx: helperIdx });
      return VOID_RESULT;
    }
  }
  return undefined;
}

/**
 * (#2604) Is `expr` syntactically `X.METHOD` where METHOD is a Set data method
 * and X is `Set.prototype` or a statically Set-typed expression? Used to gate the
 * reflective `.call`/`.apply` brand-check dispatch.
 */
function setMethodClosureName(ctx: CodegenContext, closure: ts.Expression): string | undefined {
  let e: ts.Expression = closure;
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e)) {
    e = (e as ts.ParenthesizedExpression | ts.AsExpression | ts.NonNullExpression).expression;
  }
  if (!ts.isPropertyAccessExpression(e)) return undefined;
  const method = e.name.text;
  if (!SET_BRAND_METHODS.has(method)) return undefined;
  const obj = e.expression;
  // `Set.prototype.METHOD`
  if (
    ts.isPropertyAccessExpression(obj) &&
    obj.name.text === "prototype" &&
    ts.isIdentifier(obj.expression) &&
    obj.expression.text === "Set"
  ) {
    return method;
  }
  // `<setExpr>.METHOD` where setExpr is statically a Set.
  try {
    const t = ctx.checker.getTypeAtLocation(obj);
    if (t.getSymbol()?.name === "Set") return method;
  } catch {
    /* type unavailable */
  }
  return undefined;
}

/**
 * (#2604) Reflective `Set.prototype.METHOD.call(recv, …)` /
 * `inst.METHOD.call(recv, …)` dispatch with a `[[SetData]]` brand-check.
 *
 * The direct `s.METHOD(v)` shape is handled by {@link tryCompileNativeSetMethodCall}
 * (gated on the receiver's static `className === "Set"`); the reflective `.call`
 * shape never reaches it, so neither the native dispatch nor the spec brand-check
 * (24.2.3.* "If S does not have a [[SetData]] internal slot, throw a TypeError")
 * fires. This handler recognises the `.call` form, compiles the FIRST `.call`
 * argument as the receiver, brand-checks it ({@link emitSetBrandCheck} →
 * catchable TypeError on a non-Set), then routes the remaining args to the same
 * `__set_add`/`__map_has`/`__map_delete`/`__map_clear` helpers.
 *
 * Returns the result `InnerResult` when handled, or `undefined` to fall through.
 * Scoped to add/has/delete/clear (the bulk of the ~84-row brand-check bucket);
 * forEach/keys/values/entries reflective forms fall through (rarer). `.apply`
 * (packed-args) is deferred — only `.call` is intercepted here.
 */
/**
 * (#2604) Cheap syntactic predicate (NO codegen): does `expr` match the
 * reflective Set data-method `.call` shape this module dispatches? The caller
 * (calls.ts) uses it to gate an `addUnionImports` BEFORE invoking
 * {@link tryCompileSetReflectiveCall} — the arg-boxing (`__box_number`) the
 * dispatch emits must be registered up-front (the direct path relies on
 * extern.ts doing the same), since adding it mid-body would shift indices.
 */
export function isSetReflectiveCallShape(ctx: CodegenContext, expr: ts.CallExpression): boolean {
  if (!ctx.nativeStrings) return false;
  if (!ts.isPropertyAccessExpression(expr.expression)) return false;
  const dispatch = expr.expression;
  if (dispatch.name.text !== "call") return false;
  const method = setMethodClosureName(ctx, dispatch.expression);
  return method === "add" || method === "has" || method === "delete" || method === "clear";
}

export function tryCompileSetReflectiveCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
): InnerResult | undefined {
  if (!ctx.nativeStrings) return undefined;
  if (!ts.isPropertyAccessExpression(expr.expression)) return undefined;
  const dispatch = expr.expression; // `<closure>.call`
  if (dispatch.name.text !== "call") return undefined; // .apply deferred
  const method = setMethodClosureName(ctx, dispatch.expression);
  if (method === undefined) return undefined;
  // Only the data methods are dispatched here; forEach/iterators fall through.
  if (method !== "add" && method !== "has" && method !== "delete" && method !== "clear") return undefined;

  ensureSetHelpers(ctx);
  if (ctx.mapTypeIdx < 0) return undefined;
  const helperName = method === "add" ? "__set_add" : `__map_${method}`;
  const helperIdx = ctx.mapHelpers.get(helperName);
  if (helperIdx === undefined) return undefined;

  const callArgs = expr.arguments;
  // `Set.prototype.add.call(recv, v)` — arg0 is the receiver, arg1.. are method args.
  const recvExpr = callArgs.length > 0 ? callArgs[0]! : undefined;
  const recvType = recvExpr ? compileExpression(ctx, fctx, recvExpr) : null;
  if (recvExpr === undefined) {
    // `.call()` with no receiver → `this` is undefined → TypeError.
    emitThrowTypeError(ctx, fctx, "TypeError: Method Set.prototype.* called on incompatible receiver");
    fctx.body.push({ op: "ref.null", typeIdx: ctx.mapTypeIdx } as Instr);
  } else {
    emitSetBrandCheck(ctx, fctx, recvType); // leaves (ref $Map) on the stack
  }

  switch (method) {
    case "add": {
      // (#2606 Bug A) null/undefined-literal element → canonical ref.null NONE_HEAP.
      compileCollectionElementArg(ctx, fctx, callArgs[1]);
      fctx.body.push({ op: "call", funcIdx: helperIdx });
      return { kind: "ref", typeIdx: ctx.mapTypeIdx } as ValType;
    }
    case "has":
    case "delete": {
      compileCollectionElementArg(ctx, fctx, callArgs[1]);
      fctx.body.push({ op: "call", funcIdx: helperIdx });
      return { kind: "i32" } as ValType;
    }
    case "clear": {
      fctx.body.push({ op: "call", funcIdx: helperIdx });
      return VOID_RESULT;
    }
  }
  return undefined;
}

/**
 * (#2162) Intercept the `Set.prototype.size` accessor in standalone /
 * `nativeStrings` mode → `__map_size` (returns i32). Receiver compiled here.
 */
export function tryCompileNativeSetSizeGet(
  ctx: CodegenContext,
  fctx: FunctionContext,
  receiver: ts.Expression,
): InnerResult | undefined {
  if (!ctx.nativeStrings) return undefined;
  ensureSetHelpers(ctx);
  const sizeIdx = ctx.mapHelpers.get("__map_size");
  if (sizeIdx === undefined || ctx.mapTypeIdx < 0) return undefined;
  const recvType = compileExpression(ctx, fctx, receiver);
  if (!castReceiverToMap(ctx, fctx, recvType)) return undefined;
  fctx.body.push({ op: "call", funcIdx: sizeIdx });
  return { kind: "i32" } as ValType;
}
