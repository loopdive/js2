// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Extern class helpers, spread call args, lazy prototype initialization,
 * and dynamic struct patching.
 */
import { ts } from "../../ts-api.js";
import type { Instr, ValType } from "../../ir/types.js";
import { emitBoundsCheckedArrayGet } from "../array-methods.js";
import { reportError } from "../context/errors.js";
import { allocLocal } from "../context/locals.js";
import type { CodegenContext, ExternClassInfo, FunctionContext, RestParamInfo } from "../context/types.js";
import { compileCollectionGetOrInsert } from "../collections-es2025.js";
import { addUnionImports, getArrTypeIdxFromVec } from "../index.js";
import { tryCompileNativeMapMethodCall } from "../map-runtime.js";
import { tryCompileNativeDisposableStackMethodCall } from "../disposable-runtime.js";
import { tryCompileNativeSetMethodCall } from "../set-runtime.js";
import { tryCompileNativeSetAlgebraCall } from "../set-algebra.js";
import { tryCompileNativeWeakMethodCall } from "../weak-collections-runtime.js";
import { tryCompileNativeWeakRefDeref } from "../weakref-runtime.js";
import { noJsHost } from "../js-errors.js";
import { tryEmitStaticOrNativeIsPrototypeOf } from "../native-is-prototype-of.js";
import { addStringConstantGlobal } from "../registry/imports.js";
import { emitStandaloneClassProtoObject } from "../class-proto-object.js"; // (#3976) standalone proto as a real $Object
import { classMemberFuncKey } from "../class-member-keys.js";
import { emitFuncRefAsClosure } from "../closures.js";
import type { InnerResult } from "../shared.js";
import { coerceType, compileExpression, valTypesMatch, VOID_RESULT } from "../shared.js";
import { pushDefaultValue } from "../type-coercion.js";
import { getFuncParamTypes } from "./helpers.js";

export function findExternInfoForMember(
  ctx: CodegenContext,
  className: string,
  memberName: string,
  kind: "method" | "property",
): ExternClassInfo | null {
  let current: string | undefined = className;
  while (current) {
    const info = ctx.externClasses.get(current);
    if (info) {
      if (kind === "method" && info.methods.has(memberName)) return info;
      if (kind === "property" && info.properties.has(memberName)) return info;
    }
    current = ctx.externClassParent.get(current);
  }
  return null;
}

// ── Extern method calls ──────────────────────────────────────────────

function compileExternMethodCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
): InnerResult | undefined {
  const receiverType = ctx.checker.getTypeAtLocation(propAccess.expression);
  const className = receiverType.getSymbol()?.name;
  const methodName = propAccess.name.text;

  // (#1103a) Native Map method dispatch in standalone / nativeStrings mode.
  // `Map` is registered as an externClass via the lib .d.ts scan, so without
  // this interception `m.set(...)` etc. would emit `Map_set` host imports the
  // standalone runtime can't satisfy. Route to the WasmGC-native Map runtime
  // (src/codegen/map-runtime.ts) instead. Mirrors the RegExp construction
  // interception in calls.ts. Falls through (undefined) for unsupported
  // methods so the generic extern/host path still applies in JS-host mode.
  if (className === "Map" && ctx.nativeStrings) {
    // Register box/unbox helpers up front (as native funcs in standalone mode)
    // so the Map dispatch never adds an import mid-body — a late import would
    // retrigger the #1677 native-string finalize-shift and corrupt __str_flatten.
    addUnionImports(ctx);
    // (#3172) ES2025 getOrInsert / getOrInsertComputed — native emplace over
    // the shared $Map (collections-es2025.ts).
    if (methodName === "getOrInsert" || methodName === "getOrInsertComputed") {
      const args = callExpr.arguments;
      const goiResult = compileCollectionGetOrInsert(
        ctx,
        fctx,
        propAccess.expression,
        args[0],
        args[1],
        methodName === "getOrInsertComputed",
        /* weakKeys */ false,
      );
      if (goiResult !== undefined) return goiResult;
    }
    const mapResult = tryCompileNativeMapMethodCall(ctx, fctx, propAccess, callExpr);
    if (mapResult !== undefined) return mapResult;
  }

  // (#2162) Native Set method dispatch in standalone / nativeStrings mode.
  // Without this, `s.add(...)` etc. emit `Set_add` host imports the standalone
  // runtime can't satisfy. Route to the WasmGC-native Set runtime (which reuses
  // the Map backing store). Same up-front addUnionImports rationale as Map.
  if (className === "Set" && ctx.nativeStrings) {
    addUnionImports(ctx);
    // (#2162) ES2025 set-algebra (union/intersection/…/isSubsetOf/…) first — it
    // returns a new Set or a boolean over two Set operands; the plain method
    // dispatch below doesn't recognize these names anyway, so this is the only
    // native handler for them.
    const algebraResult = tryCompileNativeSetAlgebraCall(ctx, fctx, propAccess, callExpr);
    if (algebraResult !== undefined) return algebraResult;
    const setResult = tryCompileNativeSetMethodCall(ctx, fctx, propAccess, callExpr);
    if (setResult !== undefined) return setResult;
  }

  // (#2162) Native WeakMap / WeakSet method dispatch in standalone /
  // nativeStrings mode. Without this, `wm.set(...)` / `ws.add(...)` etc. emit
  // `WeakMap_*` / `WeakSet_*` host imports the standalone runtime can't satisfy.
  // Route to the native weak-collection runtime (reuses the Map backing store).
  if ((className === "WeakMap" || className === "WeakSet") && ctx.nativeStrings) {
    addUnionImports(ctx);
    // (#3172) WeakMap.prototype.getOrInsert(Computed) — same emplace kernels
    // with the §24.5.1 CanBeHeldWeakly key gate.
    if (className === "WeakMap" && (methodName === "getOrInsert" || methodName === "getOrInsertComputed")) {
      const args = callExpr.arguments;
      const goiResult = compileCollectionGetOrInsert(
        ctx,
        fctx,
        propAccess.expression,
        args[0],
        args[1],
        methodName === "getOrInsertComputed",
        /* weakKeys */ true,
      );
      if (goiResult !== undefined) return goiResult;
    }
    const weakResult = tryCompileNativeWeakMethodCall(ctx, fctx, className, propAccess, callExpr);
    if (weakResult !== undefined) return weakResult;
  }

  // (#3242) Native WeakRef.prototype.deref in standalone / nativeStrings mode.
  // Without this, `wr.deref()` emits a `WeakRef_deref` host import the standalone
  // runtime can't satisfy. Route to the native `$WeakRef` struct (single anyref
  // target field) — `struct.get 0`. Strong-backed; see weakref-runtime.ts.
  if (className === "WeakRef" && ctx.nativeStrings && methodName === "deref") {
    const derefResult = tryCompileNativeWeakRefDeref(ctx, fctx, propAccess);
    if (derefResult !== undefined) return derefResult;
  }

  // (#3231) Native DisposableStack method dispatch in standalone / nativeStrings
  // mode. Without this, `s.defer(...)`/`.dispose()` etc. emit `DisposableStack_*`
  // host imports the standalone runtime can't satisfy. Route to the WasmGC-native
  // DisposableStack runtime — construct / disposed / defer / adopt / move / dispose
  // and (Phase 1b) `use` (dynamic [Symbol.dispose] lookup) are all native.
  // AsyncDisposableStack is Phase 2 — it falls through to the host path.
  if (className === "DisposableStack" && ctx.nativeStrings) {
    const dsResult = tryCompileNativeDisposableStackMethodCall(ctx, fctx, propAccess, callExpr);
    if (dsResult !== undefined) return dsResult;
  }

  // (#2916) `recv.isPrototypeOf(v)` on a TYPED receiver. `Object` is the ROOT
  // extern class, so every extern class inherits `isPrototypeOf` and this
  // dispatch emitted `env::Object_isPrototypeOf` — unsatisfiable host-free (9
  // sole-import leaks in the ≤ES5 standalone scope). Answer natively instead:
  // the #2994 static folds, then the WasmGC `$Object.$proto` walk. Runs BEFORE
  // the `className` guard because the receiver's class is irrelevant — every
  // object inherits this method. JS-host mode is untouched.
  if (noJsHost(ctx) && methodName === "isPrototypeOf") {
    const nativeProtoOf = tryEmitStaticOrNativeIsPrototypeOf(ctx, fctx, propAccess.expression, callExpr);
    if (nativeProtoOf !== null) return nativeProtoOf;
  }

  if (!className) return null;

  // Walk inheritance chain to find the class that declares the method
  const resolvedInfo = findExternInfoForMember(ctx, className, methodName, "method");
  const externInfo = resolvedInfo ?? ctx.externClasses.get(className);
  if (!externInfo) {
    // Unknown extern class — fall through to generic handlers
    return undefined;
  }

  // Check if the method actually has a registered import before emitting code.
  // If not, return undefined so the caller can try generic fallback handlers
  // (e.g. hasOwnProperty, toString, isPrototypeOf are handled generically).
  const methodOwner = resolvedInfo ?? externInfo;
  const methodInfo = methodOwner.methods.get(methodName);
  const importName = `${methodOwner.importPrefix}_${methodName}`;
  const funcIdx = ctx.funcMap.get(importName);
  if (funcIdx === undefined && !resolvedInfo) {
    // Method not found in extern class hierarchy and no import registered — fall through
    return undefined;
  }

  // Push 'this' (the receiver object)
  compileExpression(ctx, fctx, propAccess.expression);

  // Push arguments with type hints (params[0] is 'this', args start at [1])
  const extMethodParamCount = methodInfo ? methodInfo.params.length - 1 : callExpr.arguments.length;
  for (let i = 0; i < callExpr.arguments.length; i++) {
    if (i < extMethodParamCount) {
      const hint = methodInfo?.params[i + 1]; // +1 to skip 'this'
      compileExpression(ctx, fctx, callExpr.arguments[i]!, hint);
    } else {
      const extraType = compileExpression(ctx, fctx, callExpr.arguments[i]!);
      if (extraType !== null) {
        fctx.body.push({ op: "drop" });
      }
    }
  }

  // Pad missing optional args with default values
  if (methodInfo) {
    const actualArgs = Math.min(callExpr.arguments.length, extMethodParamCount) + 1; // +1 for 'this'
    for (let i = actualArgs; i < methodInfo.params.length; i++) {
      if (
        ctx.requiresStandaloneDomInteractionCapability === true &&
        importName === "HTMLElement_addEventListener" &&
        i === 3
      ) {
        // The authenticated interaction adapter accepts only an omitted
        // options sentinel. Native standalone's general undefined singleton
        // crosses externref as an opaque WasmGC object, so this exact optional
        // DOM position uses the ABI's null sentinel instead.
        fctx.body.push({ op: "ref.null.extern" });
      } else {
        pushDefaultValue(fctx, methodInfo.params[i]!, ctx);
      }
    }
  }

  if (funcIdx === undefined) {
    reportError(ctx, callExpr, `Missing import for method: ${importName}`);
    return null;
  }

  fctx.body.push({ op: "call", funcIdx });

  if (!methodInfo || methodInfo.results.length === 0) return VOID_RESULT;
  return methodInfo.results[0]!;
}

// ── Helper: push default value for a type ────────────────────────────

/**
 * Emit a lazy-initialized prototype global access.
 * On first access, creates a struct instance with default values and stores it
 * as externref in the global. Subsequent accesses return the same instance.
 * This gives reference identity for ClassName.prototype === Object.getPrototypeOf(instance).
 */
export function emitLazyProtoGet(ctx: CodegenContext, fctx: FunctionContext, className: string): boolean {
  if (ctx.protoGlobals?.get(className) === undefined) return false;

  const structTypeIdx = ctx.structMap.get(className);
  const fields = ctx.structFields.get(className);
  if (structTypeIdx === undefined || !fields) return false;

  // (#3976) Standalone: build the prototype as a REAL `$Object` with the class's
  // methods installed as own data properties at §17 attributes, so the whole
  // reflective surface (gOPD / hasOwnProperty / propertyIsEnumerable / for-in /
  // write-through / delete) answers through the existing `$Object` natives.
  // Declines — leaving nothing emitted — for accessors-only classes, classes
  // with a builtin parent, and every non-standalone target, which then take the
  // legacy defaulted-struct path below unchanged. See class-proto-object.ts for
  // why the descriptor-synthesis alternative was measured to be worth zero.
  if (emitStandaloneClassProtoObject(ctx, fctx, className, ctx.protoGlobals.get(className)!, emitLazyClassObjectGet)) {
    return true;
  }

  // #1047 — look up the pre-registered __register_prototype host import (added
  // in generateModule when any class declaration is present). The CSV string
  // global is registered lazily here so classes whose prototype is never
  // materialized don't force a `string_constants` namespace import.
  const registerProtoFuncIdx = ctx.funcMap.get("__register_prototype");
  let csvGlobalIdx = ctx.classMethodsCsvGlobal.get(className);
  if (registerProtoFuncIdx !== undefined && csvGlobalIdx === undefined) {
    const methodNames = ctx.classMethodNames.get(className) ?? [];
    const methodsCsv = methodNames.join(",");
    addStringConstantGlobal(ctx, methodsCsv);
    csvGlobalIdx = ctx.stringGlobalMap.get(methodsCsv);
    if (csvGlobalIdx !== undefined) {
      ctx.classMethodsCsvGlobal.set(className, csvGlobalIdx);
    }
  }
  const protoGlobalIdx = ctx.protoGlobals.get(className)!;

  // Build the init body: push default values for all fields, struct.new, extern.convert_any, global.set
  const initBody: Instr[] = [];
  for (const field of fields) {
    if (field.name === "__tag") {
      const tag = ctx.classTagMap.get(className) ?? 0;
      initBody.push({ op: "i32.const", value: tag });
    } else {
      // Push default value for each field type
      switch (field.type.kind) {
        case "f64":
          initBody.push({ op: "f64.const", value: 0 });
          break;
        case "i32":
          initBody.push({ op: "i32.const", value: 0 });
          break;
        case "i64":
          initBody.push({ op: "i64.const", value: 0n });
          break;
        case "externref":
          initBody.push({ op: "ref.null.extern" });
          break;
        case "ref_null":
          initBody.push({ op: "ref.null", typeIdx: field.type.typeIdx });
          break;
        case "ref":
          initBody.push({ op: "ref.null", typeIdx: field.type.typeIdx });
          break;
        default:
          initBody.push({ op: "i32.const", value: 0 });
          break;
      }
    }
  }
  initBody.push({ op: "struct.new", typeIdx: structTypeIdx });
  initBody.push({ op: "extern.convert_any" });
  initBody.push({ op: "global.set", index: protoGlobalIdx });

  // #1047 — after the proto is stashed, call `__register_prototype(proto, csv)`
  // so the host-side Proxy wrapper can present a method-only own-key set and
  // hide leaking instance fields. Emitted inside `initBody` so it fires once
  // per class (on first access), not on every prototype read.
  if (registerProtoFuncIdx !== undefined && csvGlobalIdx !== undefined) {
    initBody.push({ op: "global.get", index: protoGlobalIdx });
    initBody.push({ op: "global.get", index: csvGlobalIdx });
    initBody.push({ op: "call", funcIdx: registerProtoFuncIdx });
  }

  // Emit: if global is null, init it; then get it
  fctx.body.push({ op: "global.get", index: protoGlobalIdx });
  fctx.body.push({ op: "ref.is_null" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: initBody,
    else: [],
  });
  fctx.body.push({ op: "global.get", index: protoGlobalIdx });
  return true;
}

/**
 * (#1395) Emit a lazy-initialized class-object global access. Mirrors
 * `emitLazyProtoGet` above but for the class identifier itself (not its
 * prototype). On first access, creates a `$ClassName` struct with default
 * field values and registers static method names with the runtime's
 * `_staticMethodNames` allowlist via `__register_class_object`. Subsequent
 * accesses return the same instance, giving reference identity for
 * `C === C`.
 *
 * Returns `true` if a class-object global was emitted, `false` if no global
 * was registered for this class (e.g. externref-backed builtin subclasses
 * from #1366a).
 */
export function emitLazyClassObjectGet(ctx: CodegenContext, fctx: FunctionContext, className: string): boolean {
  if (ctx.classObjectGlobals?.get(className) === undefined) return false;

  const structTypeIdx = ctx.structMap.get(className);
  const fields = ctx.structFields.get(className);
  if (structTypeIdx === undefined || !fields) return false;

  // Look up the pre-registered `__register_class_object` host import (added
  // in `generateModule` when any class declaration is present). CSV string
  // global is registered lazily here so classes whose class object is
  // never materialized don't force a `string_constants` namespace import.
  const registerClassFuncIdx = ctx.funcMap.get("__register_class_object");
  let csvGlobalIdx = ctx.classStaticMethodsCsvGlobal.get(className);
  if (registerClassFuncIdx !== undefined && csvGlobalIdx === undefined) {
    const staticMethodNames = ctx.classStaticMethodNames.get(className) ?? [];
    const staticMethodsCsv = staticMethodNames.join(",");
    addStringConstantGlobal(ctx, staticMethodsCsv);
    csvGlobalIdx = ctx.stringGlobalMap.get(staticMethodsCsv);
    if (csvGlobalIdx !== undefined) {
      ctx.classStaticMethodsCsvGlobal.set(className, csvGlobalIdx);
    }
  }
  const classObjectGlobalIdx = ctx.classObjectGlobals.get(className)!;

  // Build the init body: push default values for all fields, struct.new,
  // extern.convert_any, global.set. Same shape as emitLazyProtoGet — the
  // class object reuses the `$ClassName` struct type. Identity is provided
  // by the singleton global, not by struct shape.
  const initBody: Instr[] = [];
  for (const field of fields) {
    if (field.name === "__tag") {
      const tag = ctx.classTagMap.get(className) ?? 0;
      initBody.push({ op: "i32.const", value: tag });
    } else {
      switch (field.type.kind) {
        case "f64":
          initBody.push({ op: "f64.const", value: 0 });
          break;
        case "i32":
          initBody.push({ op: "i32.const", value: 0 });
          break;
        case "i64":
          initBody.push({ op: "i64.const", value: 0n });
          break;
        case "externref":
          initBody.push({ op: "ref.null.extern" });
          break;
        case "ref_null":
          initBody.push({ op: "ref.null", typeIdx: field.type.typeIdx });
          break;
        case "ref":
          initBody.push({ op: "ref.null", typeIdx: field.type.typeIdx });
          break;
        default:
          initBody.push({ op: "i32.const", value: 0 });
          break;
      }
    }
  }
  initBody.push({ op: "struct.new", typeIdx: structTypeIdx });
  initBody.push({ op: "extern.convert_any" });
  initBody.push({ op: "global.set", index: classObjectGlobalIdx });

  // Register static methods with the runtime's `_staticMethodNames`
  // allowlist so `Object.getOwnPropertyDescriptor(C, "m")` returns the
  // spec descriptor.
  if (registerClassFuncIdx !== undefined && csvGlobalIdx !== undefined) {
    initBody.push({ op: "global.get", index: classObjectGlobalIdx });
    initBody.push({ op: "global.get", index: csvGlobalIdx });
    initBody.push({ op: "call", funcIdx: registerClassFuncIdx });
  }

  // (#4371) Install the REAL compiled closures behind declared static-method
  // reads on a dynamically carried class object. The legacy registration above
  // provides the own-key/descriptor allowlist but its host bridge is only a
  // throwing placeholder. A descriptor-aware sidecar value preserves the
  // class object's closed-struct identity (needed by dynamic `new K()`) while
  // letting the existing host closure wrapper dispatch back into Wasm.
  //
  // Build this inside `initBody`: the singleton guard means each closure is
  // created once, and sidecar reads/reassign/delete all observe that same value.
  const registerStaticMethodIdx = ctx.funcMap.get("__register_class_static_method");
  if (registerStaticMethodIdx !== undefined) {
    const staticMethodNames = ctx.classStaticMethodNames.get(className) ?? [];
    const savedBody = fctx.body;
    fctx.body = initBody;
    ctx.liveBodies.add(savedBody);
    try {
      for (const methodName of staticMethodNames) {
        const fullName = `${className}_${methodName}`;
        const methodIdx = ctx.funcMap.get(classMemberFuncKey(ctx, fullName, "static"));
        if (methodIdx === undefined) continue;
        addStringConstantGlobal(ctx, methodName);
        const methodNameGlobalIdx = ctx.stringGlobalMap.get(methodName);
        if (methodNameGlobalIdx === undefined) continue;

        fctx.body.push({ op: "global.get", index: classObjectGlobalIdx });
        fctx.body.push({ op: "global.get", index: methodNameGlobalIdx });
        const closureType = emitFuncRefAsClosure(ctx, fctx, fullName, methodIdx);
        if (closureType === null) {
          // Leave reflection on the established placeholder path if this
          // method cannot be represented as a closure. Do not install a wrong
          // value or change the class-object allowlist.
          fctx.body.splice(fctx.body.length - 2, 2);
          continue;
        }
        fctx.body.push({ op: "extern.convert_any" });
        fctx.body.push({ op: "call", funcIdx: registerStaticMethodIdx });
      }
    } finally {
      fctx.body = savedBody;
      ctx.liveBodies.delete(savedBody);
    }
  }

  // Emit: if global is null, init it; then get it.
  fctx.body.push({ op: "global.get", index: classObjectGlobalIdx });
  fctx.body.push({ op: "ref.is_null" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: initBody,
    else: [],
  });
  fctx.body.push({ op: "global.get", index: classObjectGlobalIdx });
  return true;
}

/**
 * After dynamically adding a field to a struct type, patch all existing
 * struct.new instructions in compiled function bodies so they push a default
 * value for the new field. Without this, struct.new expects N values on the
 * stack but the constructor only pushed N-1.
 */
function patchStructNewForDynamicField(ctx: CodegenContext, structTypeIdx: number, newFieldType: ValType): void {
  // Walk all compiled function bodies and patch struct.new instructions
  for (const func of ctx.mod.functions) {
    if (!func.body || func.body.length === 0) continue;
    patchStructNewInBody(func.body, structTypeIdx, newFieldType);
  }
  // Also patch the current function being compiled (if any)
  if (ctx.currentFunc) {
    patchStructNewInBody(ctx.currentFunc.body, structTypeIdx, newFieldType);
    // Also patch saved bodies (from pushBody/popBody pattern)
    if (ctx.currentFunc.savedBodies) {
      for (const savedBody of ctx.currentFunc.savedBodies) {
        patchStructNewInBody(savedBody, structTypeIdx, newFieldType);
      }
    }
  }
}

/** Recursively patch struct.new instructions in a body (handles nested if/block/loop). */
function patchStructNewInBody(body: Instr[], structTypeIdx: number, newFieldType: ValType): void {
  for (let i = 0; i < body.length; i++) {
    const instr = body[i]!;
    if (instr.op === "struct.new" && (instr as any).typeIdx === structTypeIdx) {
      // Insert default value instruction before this struct.new
      const defaultInstr = defaultValueInstrForType(newFieldType);
      body.splice(i, 0, ...defaultInstr);
      i += defaultInstr.length; // skip past inserted instructions
    }
    // Recurse into nested blocks
    if ((instr as any).then) patchStructNewInBody((instr as any).then, structTypeIdx, newFieldType);
    if ((instr as any).else) patchStructNewInBody((instr as any).else, structTypeIdx, newFieldType);
    if ((instr as any).body) {
      // block, loop, try instructions
      const nestedBody = (instr as any).body;
      if (Array.isArray(nestedBody)) patchStructNewInBody(nestedBody, structTypeIdx, newFieldType);
    }
    if ((instr as any).instrs) {
      const nestedInstrs = (instr as any).instrs;
      if (Array.isArray(nestedInstrs)) patchStructNewInBody(nestedInstrs, structTypeIdx, newFieldType);
    }
    // try/catch blocks
    if ((instr as any).catches) {
      for (const c of (instr as any).catches) {
        if (Array.isArray(c.body)) patchStructNewInBody(c.body, structTypeIdx, newFieldType);
      }
    }
    if ((instr as any).catchAll) {
      if (Array.isArray((instr as any).catchAll))
        patchStructNewInBody((instr as any).catchAll, structTypeIdx, newFieldType);
    }
  }
}

/** Return instructions that produce a default value for a given type. */
function defaultValueInstrForType(type: ValType): Instr[] {
  switch (type.kind) {
    case "f64":
      return [{ op: "f64.const", value: 0 }];
    case "i32":
      return [{ op: "i32.const", value: 0 }];
    case "externref":
      return [{ op: "ref.null.extern" }];
    case "ref_null":
      return [{ op: "ref.null", typeIdx: type.typeIdx }];
    case "ref":
      return [{ op: "ref.null", typeIdx: type.typeIdx }, { op: "ref.as_non_null" }];
    case "eqref":
      return [{ op: "ref.null.eq" }];
    default:
      return [{ op: "i32.const", value: 0 }];
  }
}

/**
 * Emit a null-guarded struct.get: if the object ref on the stack is null (e.g.
 * from a failed ref.cast that returned ref.null), produce a default value
 * instead of trapping. This handles wrong-type-but-not-truly-null cases. If the
 * source value is truly null/undefined, the TypeError is thrown on the
 * externref __extern_get path instead.
 * push a default value instead of trapping.
 *
 * Expects the object ref to be on the Wasm stack. Emits:
 *   local.tee $tmp
 *   ref.is_null
 *   if (result fieldType)
 *     <default_value>
 *   else
 *     local.get $tmp
 *     struct.get typeIdx fieldIdx
 *   end
 *
 * Returns the field's ValType.
 */

/**
 * Emit instructions that throw a TypeError via the Wasm exception tag.
 * Pushes a null externref as the exception payload and then emits `throw`.
 * This is used for null/undefined property access, calling non-functions, etc.
 *
 * Returns an array of instructions (for use inside if-then blocks).
 */
function compileSpreadCallArgs(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  funcIdx: number,
  restInfo: RestParamInfo | undefined,
): void {
  const paramTypes = getFuncParamTypes(ctx, funcIdx);

  if (restInfo) {
    // Calling a rest-param function with spread — compile non-rest args normally,
    // then for the rest portion, if it's a single spread of an array, pass directly
    let argIdx = 0;
    for (let i = 0; i < restInfo.restIndex; i++) {
      if (argIdx < expr.arguments.length) {
        compileExpression(ctx, fctx, expr.arguments[argIdx]!, paramTypes?.[i]);
        argIdx++;
      }
    }
    // Remaining args should be a single spread element — pass the vec directly
    if (argIdx < expr.arguments.length) {
      const restArg = expr.arguments[argIdx]!;
      if (ts.isSpreadElement(restArg)) {
        // The spread source is already a vec struct — pass directly
        compileExpression(ctx, fctx, restArg.expression);
      } else {
        // Single non-spread arg as rest — wrap in vec struct { 1, [val] }
        fctx.body.push({ op: "i32.const", value: 1 });
        compileExpression(ctx, fctx, restArg, restInfo.elemType);
        fctx.body.push({
          op: "array.new_fixed",
          typeIdx: restInfo.arrayTypeIdx,
          length: 1,
        });
        fctx.body.push({ op: "struct.new", typeIdx: restInfo.vecTypeIdx });
      }
    } else {
      // No rest args provided — pass empty vec struct { 0, [] }
      fctx.body.push({ op: "i32.const", value: 0 });
      fctx.body.push({
        op: "array.new_fixed",
        typeIdx: restInfo.arrayTypeIdx,
        length: 0,
      });
      fctx.body.push({ op: "struct.new", typeIdx: restInfo.vecTypeIdx });
    }
    return;
  }

  // Non-rest target: fn(...arr) — unpack array elements from vec struct into positional args
  // Strategy: for each spread arg, store the vec in a local, extract data array, then extract elements by index
  if (!paramTypes) return;

  // Count non-spread (positional) args that follow each argument index, so a
  // spread that precedes trailing positional args reserves their param slots
  // instead of greedily consuming every remaining parameter (#2053). Without
  // this, `f(...arr, x)` reads one element too many out of the spread vec
  // (OOB → NaN) and compiles `x` as a surplus stack value.
  const args = expr.arguments;
  const trailingPositionalAfter: number[] = new Array(args.length).fill(0);
  for (let i = args.length - 2; i >= 0; i--) {
    const next = args[i + 1]!;
    trailingPositionalAfter[i] = trailingPositionalAfter[i + 1]! + (ts.isSpreadElement(next) ? 0 : 1);
  }

  // Collect all arguments, resolving spreads
  let paramIdx = 0;
  for (let argPos = 0; argPos < args.length; argPos++) {
    const arg = args[argPos]!;
    if (ts.isSpreadElement(arg)) {
      // Compile the spread source (vec struct)
      const vecType = compileExpression(ctx, fctx, arg.expression);
      if (!vecType || (vecType.kind !== "ref" && vecType.kind !== "ref_null")) continue;

      const vecTypeDef = ctx.mod.types[vecType.typeIdx];
      if (!vecTypeDef || vecTypeDef.kind !== "struct") continue;

      // Extract data array from vec struct
      const vecLocal = allocLocal(fctx, `__spread_vec_${fctx.locals.length}`, vecType);
      fctx.body.push({ op: "local.set", index: vecLocal });

      const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecType.typeIdx);
      if (arrTypeIdx < 0) continue;
      const dataLocal = allocLocal(fctx, `__spread_data_${fctx.locals.length}`, {
        kind: "ref_null",
        typeIdx: arrTypeIdx,
      });
      fctx.body.push({ op: "local.get", index: vecLocal });
      fctx.body.push({
        op: "struct.get",
        typeIdx: vecType.typeIdx,
        fieldIdx: 1,
      });
      fctx.body.push({ op: "local.set", index: dataLocal });

      // Extract elements up to the remaining parameter count
      const arrDefSpread = ctx.mod.types[arrTypeIdx];
      const spreadElemType =
        arrDefSpread && arrDefSpread.kind === "array" ? arrDefSpread.element : { kind: "f64" as const };
      // Reserve param slots for trailing positional args after this spread so
      // the spread only expands into the parameters it actually covers (#2053).
      const reservedForTrailing = trailingPositionalAfter[argPos] ?? 0;
      const remainingParams = Math.max(0, paramTypes.length - paramIdx - reservedForTrailing);
      for (let i = 0; i < remainingParams; i++) {
        fctx.body.push({ op: "local.get", index: dataLocal });
        fctx.body.push({ op: "i32.const", value: i });
        emitBoundsCheckedArrayGet(fctx, arrTypeIdx, spreadElemType);
        // Coerce spread element to expected param type if they differ
        const expectedParamType = paramTypes[paramIdx];
        if (expectedParamType && !valTypesMatch(spreadElemType, expectedParamType)) {
          coerceType(ctx, fctx, spreadElemType, expectedParamType);
        }
        paramIdx++;
      }
    } else {
      compileExpression(ctx, fctx, arg, paramTypes[paramIdx]);
      paramIdx++;
    }
  }
}

export {
  compileExternMethodCall,
  compileSpreadCallArgs,
  defaultValueInstrForType,
  patchStructNewForDynamicField,
  patchStructNewInBody,
};
