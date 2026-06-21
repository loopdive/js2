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
import type { CodegenContext, FunctionContext } from "./context/types.js";
import {
  coerceSetArgToAnyref,
  compileNativeCollectionIterator,
  ensureMapHelpers,
  tryCompileNativeCollectionForEach,
} from "./map-runtime.js";
import { addFuncType } from "./registry/types.js";
import type { InnerResult } from "./shared.js";
import { VOID_RESULT, compileExpression } from "./shared.js";

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
      const vt = args.length > 0 ? compileExpression(ctx, fctx, args[0]!) : null;
      coerceSetArgToAnyref(ctx, fctx, vt);
      fctx.body.push({ op: "call", funcIdx: helperIdx });
      // __set_add returns ref $Map (the set) — chainable.
      return { kind: "ref", typeIdx: ctx.mapTypeIdx } as ValType;
    }
    case "has":
    case "delete": {
      const vt = args.length > 0 ? compileExpression(ctx, fctx, args[0]!) : null;
      coerceSetArgToAnyref(ctx, fctx, vt);
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
