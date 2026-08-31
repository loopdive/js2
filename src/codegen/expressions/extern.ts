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
import { addUnionImports, getArrTypeIdxFromVec, hostMapCarrierClassName } from "../index.js";
import { tryCompileNativeMapMethodCall } from "../map-runtime.js";
import { tryCompileNativeDisposableStackMethodCall } from "../disposable-runtime.js";
import { tryCompileNativeSetMethodCall } from "../set-runtime.js";
import { tryCompileNativeSetAlgebraCall } from "../set-algebra.js";
import { tryCompileNativeWeakMethodCall } from "../weak-collections-runtime.js";
import { tryCompileNativeWeakRefDeref } from "../weakref-runtime.js";
import { noJsHost } from "../js-errors.js";
import { tryEmitStaticOrNativeIsPrototypeOf } from "../native-is-prototype-of.js";
import { addHostStringConstantGlobal } from "../registry/imports.js";
import { emitStandaloneClassProtoObject } from "../class-proto-object.js"; // (#3976) standalone proto as a real $Object
import { classMemberFuncKey, fnctorAncestorOfClass } from "../class-member-keys.js";
import { emitFuncRefAsClosure } from "../closures.js";
import { emitCachedFuncClosureAccess } from "../closures/method-trampolines.js";
import { stringConstantExternrefInstrs } from "../native-strings.js";
import type { InnerResult } from "../shared.js";
import {
  coerceType,
  compileExpression,
  compileStringLiteral,
  ensureLateImport,
  flushLateImportShifts,
  valTypesMatch,
  VOID_RESULT,
} from "../shared.js";
import { pushDefaultValue } from "../type-coercion.js";
import { getFuncParamTypes } from "./helpers.js";
import { tupleStructFields } from "./spread-arguments-call.js";

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

interface BuiltinClassStaticParentRegistration {
  parentName: string;
  registerClassParentIdx: number;
  getBuiltinIdx: number;
}

function prepareBuiltinClassStaticParent(
  ctx: CodegenContext,
  fctx: FunctionContext,
  className: string,
): BuiltinClassStaticParentRegistration | undefined {
  if (ctx.standalone || ctx.wasi) return undefined;
  const parentName = ctx.classBuiltinParentMap.get(className);
  if (parentName === undefined) return undefined;
  addHostStringConstantGlobal(ctx, parentName);
  const registerClassParentIdx = ensureLateImport(
    ctx,
    "__register_class_parent",
    [{ kind: "externref" }, { kind: "externref" }],
    [],
  );
  const getBuiltinIdx = ensureLateImport(ctx, "__get_builtin", [{ kind: "externref" }], [{ kind: "externref" }]);
  flushLateImportShifts(ctx, fctx);
  if (registerClassParentIdx === undefined || getBuiltinIdx === undefined) return undefined;
  return { parentName, registerClassParentIdx, getBuiltinIdx };
}

function emitBuiltinClassStaticParent(
  ctx: CodegenContext,
  initBody: Instr[],
  className: string,
  registration: BuiltinClassStaticParentRegistration | undefined,
): void {
  if (registration === undefined) return;
  initBody.push(...stringConstantExternrefInstrs(ctx, className));
  initBody.push(...stringConstantExternrefInstrs(ctx, registration.parentName));
  initBody.push({ op: "call", funcIdx: registration.getBuiltinIdx });
  initBody.push({
    op: "call",
    funcIdx: ctx.funcMap.get("__register_class_parent") ?? registration.registerClassParentIdx,
  });
}

// ── Extern method calls ──────────────────────────────────────────────

function compileExternMethodCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
): InnerResult | undefined {
  const receiverType = ctx.checker.getTypeAtLocation(propAccess.expression);
  const className = hostMapCarrierClassName(ctx, receiverType) ?? receiverType.getSymbol()?.name;
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
    csvGlobalIdx = addHostStringConstantGlobal(ctx, methodsCsv);
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
 * was registered for this class, or if the class has no `$ClassName` struct
 * layout to build the singleton from.
 *
 * (#5191) Externref-backed builtin subclasses (`class C extends Array/Error/
 * Map`) DO reach this path now. class-bodies.ts skipped registering their
 * class-object global from #1366a until 2026-08-29, on the stated ground that
 * "those don't have a `$ClassName` WasmGC struct". That premise was false —
 * `ctx.structMap.set(className, …)` runs unconditionally, long before any
 * builtin-parent branch. What such a subclass lacks is struct *instances*
 * (its objects are host-created externrefs), and that is precisely what makes
 * the otherwise-unused `$ClassName` struct a SAFE carrier for the class
 * object: no instance can ever be confused with the singleton.
 *
 * With no global, the identifier read in expressions/identifiers.ts fell
 * through every registry to `ref.null.extern`, so the class evaluated to
 * `null` as a VALUE — `C == null` true, `Boolean(C)` false, and any property
 * read on it threw "Cannot access property on null or undefined". `typeof C`,
 * `C.name` and `new C()` masked it: those are served by statically resolved
 * arms that never materialize the constructor object. That null is what
 * killed the compiled `@js-temporal/polyfill` bundle at its second top-level
 * statement (`class JSBI extends Array` plus a comma sequence of static-table
 * writes) — #4628 Option A.
 *
 * The carrier choice was deliberate: reuse this one rather than add a second,
 * `__new_plain_object`-backed shape for the builtin-derived lane. The
 * static-method / `.name` / gOPD / `__register_class_ctor` registrations below
 * already depend on the class object's closed-struct identity, and the two
 * `undefined` bails immediately above remain the real guard — a class with no
 * struct layout still returns `false` here.
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
    csvGlobalIdx = addHostStringConstantGlobal(ctx, staticMethodsCsv);
    if (csvGlobalIdx !== undefined) {
      ctx.classStaticMethodsCsvGlobal.set(className, csvGlobalIdx);
    }
  }
  // (#4618) Pre-intern EVERY string constant any block below may need, BEFORE
  // a single instruction is baked. String constants are IMPORTED globals and
  // an import prepends to the global index space — an intern that happens
  // mid-build leaves every already-baked `global.get` off by one (measured
  // via wasm-dis on a 2-method class: the lazy-init CHECKED the proto global
  // but SET/registered the class-object global, so the read returned the
  // PROTO struct and the host [[Construct]] bridge never matched).
  if (!ctx.standalone && !ctx.wasi) {
    addHostStringConstantGlobal(ctx, "name");
    addHostStringConstantGlobal(ctx, className);
    for (const m of ctx.classStaticMethodNames.get(className) ?? []) {
      addHostStringConstantGlobal(ctx, m);
    }
  }

  const builtinParentRegistration = prepareBuiltinClassStaticParent(ctx, fctx, className);
  // (#4618) The class-object global index MUST be re-read at every push:
  // string-constant interning inserts an IMPORTED global, and the shift
  // repair updates ctx.classObjectGlobals plus every REACHABLE body — a
  // captured const goes stale the moment any nested emission interns
  // (measured via wasm-dis: the lazy-init checked the proto global but set
  // the class-object global, so reads returned the PROTO struct).
  const classObjIdx = (): number => ctx.classObjectGlobals!.get(className)!;

  // Build the init body: push default values for all fields, struct.new,
  // extern.convert_any, global.set. Same shape as emitLazyProtoGet — the
  // class object reuses the `$ClassName` struct type. Identity is provided
  // by the singleton global, not by struct shape.
  // (#4618) Registered in liveBodies for the WHOLE construction window so
  // the imported-global shift repair reaches instructions already baked
  // into this (otherwise detached) array.
  const initBody: Instr[] = [];
  ctx.liveBodies.add(initBody);
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
  initBody.push({ op: "global.set", index: classObjIdx() });

  // Register static methods with the runtime's `_staticMethodNames`
  // allowlist so `Object.getOwnPropertyDescriptor(C, "m")` returns the
  // spec descriptor.
  if (registerClassFuncIdx !== undefined && csvGlobalIdx !== undefined) {
    initBody.push({ op: "global.get", index: classObjIdx() });
    initBody.push({ op: "global.get", index: csvGlobalIdx });
    initBody.push({ op: "call", funcIdx: registerClassFuncIdx });
  }

  // (#4616) §10.2.9 SetFunctionName: stamp `.name` into the class object's
  // sidecar once at singleton init, so a dynamic `.name` read in ANOTHER
  // module (jest's convertDescriptorToString over a `class Named {}` value)
  // answers the declared name instead of undefined. Host lane only; synthetic
  // class names (`__…`) are never stamped.
  // A static accessor named `name` replaces the constructor's standard data
  // property during ClassDefinitionEvaluation. The host-side metadata stamp
  // is an implementation detail, not another Set operation: emitting it for
  // a setter-only `name` accessor would invoke the setter while the class is
  // being defined (and a throwing test262 setter must remain idle). A static
  // `length` accessor does not own the `name` key, so it must not suppress the
  // independent class-name stamp for dynamic class-object reads.
  const hasStaticNameAccessor = ctx.staticAccessorSet.has(`${className}_name`);
  if (!ctx.standalone && !ctx.wasi && !className.startsWith("__") && !hasStaticNameAccessor) {
    const setIdx = ctx.funcMap.get("__extern_set");
    if (setIdx !== undefined) {
      const nameKeyIdx = addHostStringConstantGlobal(ctx, "name");
      const nameValIdx = addHostStringConstantGlobal(ctx, className);
      if (nameKeyIdx !== undefined && nameValIdx !== undefined) {
        initBody.push({ op: "global.get", index: classObjIdx() });
        initBody.push({ op: "global.get", index: nameKeyIdx });
        initBody.push({ op: "global.get", index: nameValIdx });
        initBody.push({ op: "call", funcIdx: setIdx });
      }
    }
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
        const methodNameGlobalIdx = addHostStringConstantGlobal(ctx, methodName);
        if (methodNameGlobalIdx === undefined) continue;

        fctx.body.push({ op: "global.get", index: classObjIdx() });
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

  // (#4618) Register the compiled constructor closure + prototype + fnctor
  // parent so the host proxy can present this class object as a CONSTRUCTIBLE
  // function (react-dom's `new type(props, context)` on a compiled
  // `class Foo extends React.Component`). The import is pre-registered in
  // generateModule (never late-added here — initBody already holds baked call
  // indices that an import shift would invalidate). Emitted inside initBody so
  // it fires once, before the class object value can ever cross to the host.
  const registerCtorIdx = ctx.funcMap.get("__register_class_ctor");
  if (registerCtorIdx !== undefined) {
    const ctorFullName = `${className}_new`;
    const ctorIdx0 = ctx.funcMap.get(classMemberFuncKey(ctx, ctorFullName));
    if (ctorIdx0 !== undefined) {
      // Pre-hoist the import emitLazyProtoGet will need, BEFORE any ref.func
      // is baked below — flushLateImportShifts repairs call sites in tracked
      // bodies but a ref.func baked ahead of an import add stays stale (the
      // promise-subclass registration learned the same lesson).
      ensureLateImport(ctx, "__new_plain_object", [], [{ kind: "externref" }]);
      flushLateImportShifts(ctx, fctx);
      const ctorIdx = ctx.funcMap.get(classMemberFuncKey(ctx, ctorFullName)) ?? ctorIdx0;
      const savedBody = fctx.body;
      fctx.body = initBody;
      ctx.liveBodies.add(savedBody);
      try {
        fctx.body.push({ op: "global.get", index: classObjIdx() });
        const ctorClosureType = emitFuncRefAsClosure(ctx, fctx, ctorFullName, ctorIdx);
        if (ctorClosureType === null) {
          fctx.body.pop(); // unbalanced classObj push — abandon registration
        } else {
          fctx.body.push({ op: "extern.convert_any" });
          // arg 2 — the prototype singleton (its own lazy-init nests cleanly).
          if (!emitLazyProtoGet(ctx, fctx, className)) {
            fctx.body.push({ op: "ref.null.extern" });
          }
          // arg 3 — the fnctor ancestor's canonical cached closure (the chain
          // `Foo.prototype.isReactComponent` must answer through), or null.
          const fnctorParent = fnctorAncestorOfClass(ctx, className);
          const fnctorIdx = fnctorParent !== undefined ? ctx.funcMap.get(fnctorParent) : undefined;
          let pushedParent = false;
          if (fnctorParent !== undefined && fnctorIdx !== undefined) {
            const closTy = emitCachedFuncClosureAccess(ctx, fctx, fnctorParent, fnctorIdx);
            if (closTy !== null) {
              fctx.body.push({ op: "extern.convert_any" });
              pushedParent = true;
            }
          }
          // Dynamic heritage (react's `class Foo extends React.Component`) is
          // NOT evaluated here: compiling an arbitrary expression inside
          // initBody corrupts the already-baked instruction stream (measured:
          // the first class-value crossing produced a foreign struct). The
          // declaration-statement site registers it instead — see
          // emitRegisterDynamicClassParent, which is also the spec-correct
          // `extends` evaluation point (§15.7.14 step 5).
          if (!pushedParent) fctx.body.push({ op: "ref.null.extern" });
          // arg 4 — the class NAME, so the runtime mirror can key the
          // dynamic-parent lookup and stamp `.name` without relying on the
          // (#4616) sidecar stamp having run.
          const classNameGlobalIdx = addHostStringConstantGlobal(ctx, className);
          if (classNameGlobalIdx !== undefined) {
            fctx.body.push({ op: "global.get", index: classNameGlobalIdx });
          } else {
            fctx.body.push({ op: "ref.null.extern" });
          }
          // arg 5 — whether the source has the spec-synthesized derived
          // constructor `constructor(...args) { super(...args); }` and the
          // parent is a runtime value (for example React.Component). The
          // Wasm struct constructor cannot call that host parent directly;
          // the class mirror uses this bit to apply the parent initializer to
          // the freshly allocated proxy exactly once. Explicit constructors
          // keep owning their own `super(...)` call.
          const classDecl = ctx.classDeclarationMap.get(className);
          const hasRuntimeHeritage =
            classDecl?.heritageClauses?.some(
              (clause) => clause.token === ts.SyntaxKind.ExtendsKeyword && clause.types.length > 0,
            ) === true &&
            !ctx.classParentMap.has(className) &&
            !ctx.classBuiltinParentMap.has(className);
          const hasOwnCtor =
            classDecl?.members.some((member) => ts.isConstructorDeclaration(member) && member.body !== undefined) ===
            true;
          fctx.body.push({ op: "i32.const", value: hasRuntimeHeritage && !hasOwnCtor ? 1 : 0 });
          // Re-resolve at push time: emitLazyProtoGet above late-adds
          // `__new_plain_object`, shifting every func index after the value
          // captured at block entry (measured: the stale call index sent the
          // registration to a NEIGHBORING import for 2-method classes).
          fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__register_class_ctor") ?? registerCtorIdx });
          // The host may now dynamically invoke any of this class's instance
          // methods (react-dom's `instance.render()` / lifecycle calls) —
          // admit them to the #3123 member-dispatch export surface.
          for (const m of ctx.classMethodNames.get(className) ?? []) {
            ctx.hostDynamicClassMethodNames.add(m);
          }
          const accPrefix4618 = `${className}_`;
          for (const acc of ctx.classAccessorSet) {
            if (acc.startsWith(accPrefix4618)) ctx.hostDynamicClassMethodNames.add(acc.slice(accPrefix4618.length));
          }
        }
      } finally {
        fctx.body = savedBody;
        ctx.liveBodies.delete(savedBody);
      }
    }
  }

  // (#5206) Record the host builtin parent after constructor registration.
  emitBuiltinClassStaticParent(ctx, initBody, className, builtinParentRegistration);

  // Emit: if global is null, init it; then get it. initBody is now embedded
  // in fctx.body (reachable through the normal body walks) — release the
  // explicit liveBodies registration.
  ctx.liveBodies.delete(initBody);
  fctx.body.push({ op: "global.get", index: classObjIdx() });
  fctx.body.push({ op: "ref.is_null" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: initBody,
    else: [],
  });
  fctx.body.push({ op: "global.get", index: classObjIdx() });
  return true;
}

/**
 * (#4618) Register a class's DYNAMIC parent value with the runtime, emitted at
 * the class DECLARATION statement — the spec's `extends` evaluation point
 * (§15.7.14 step 5), where every binding the heritage expression references is
 * in scope. Applies only when the parent could not be resolved statically
 * (no classParentMap entry — react's `class Foo extends React.Component`,
 * where the parent is a PropertyAccess on an untyped module value). The
 * runtime keys the registration by class NAME (matching the name-keyed
 * class-object singleton) so the host-side constructible mirror can chain
 * `Foo.prototype` misses to the live parent's prototype.
 */
export function emitRegisterDynamicClassParent(
  ctx: CodegenContext,
  fctx: FunctionContext,
  decl: ts.ClassDeclaration | ts.ClassExpression,
  classNameOverride?: string,
): void {
  if (ctx.standalone || ctx.wasi) return;
  const className = classNameOverride ?? decl.name?.text;
  if (className === undefined || ctx.classParentMap.has(className)) return;
  if (decl.heritageClauses === undefined) return;
  let heritageExpr: ts.Expression | undefined;
  for (const clause of decl.heritageClauses) {
    if (clause.token !== ts.SyntaxKind.ExtendsKeyword || clause.types.length === 0) continue;
    let expr: ts.Expression = clause.types[0]!.expression;
    while (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr)) expr = expr.expression;
    // A bare identifier parent that named a compiled class/builtin was
    // resolved statically (classParentMap / builtin machinery); only a value
    // parent the checker could not see reaches here.
    heritageExpr = expr;
    break;
  }
  if (heritageExpr === undefined) return;
  const regIdx = ensureLateImport(ctx, "__register_class_parent", [{ kind: "externref" }, { kind: "externref" }], []);
  flushLateImportShifts(ctx, fctx);
  if (regIdx === undefined) return;
  const nameIdx = addHostStringConstantGlobal(ctx, className);
  if (nameIdx !== undefined) {
    fctx.body.push({ op: "global.get", index: nameIdx });
  } else {
    fctx.body.push({ op: "ref.null.extern" });
  }
  // (#4618) A PROPERTY-ACCESS heritage (react's `extends React.Component`)
  // must be read through the dynamic MOP here: the static member lane can
  // bind the name to a lazily-materialized carrier that is still null at
  // this exact point (observed in the per-file react batch: the test body's
  // own `React.Component` read answered an object while the registration's
  // static read pushed null, so the mirror never chained the parent and
  // react-dom treated every class component as a function component).
  // (#4618) A PROPERTY-ACCESS heritage (react's `extends React.Component`)
  // registers the live CONTAINER + KEY instead of the value: the compiled
  // value read at this statement can cross as null through the static member
  // lane (observed in the react per-file batch — the test body's own
  // `React.Component` read answered an object while the registration pushed
  // null, so the class mirror never chained the parent and react-dom treated
  // every class component as a function component). The runtime resolves
  // `obj[key]` host-side, lazily, when the mirror needs the parent.
  if (ts.isPropertyAccessExpression(heritageExpr) && ts.isIdentifier(heritageExpr.name)) {
    const refRegIdx = ensureLateImport(
      ctx,
      "__register_class_parent_ref",
      [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
      [],
    );
    flushLateImportShifts(ctx, fctx);
    if (refRegIdx !== undefined) {
      const objT = compileExpression(ctx, fctx, heritageExpr.expression);
      if (objT === null) {
        fctx.body.push({ op: "drop" });
        return;
      }
      coerceType(ctx, fctx, objT, { kind: "externref" });
      // stack: [nameStr, obj] — now the key string
      const propName = heritageExpr.name.text;
      const propIdx = addHostStringConstantGlobal(ctx, propName);
      if (propIdx !== undefined) {
        fctx.body.push({ op: "global.get", index: propIdx });
      } else {
        fctx.body.push({ op: "ref.null.extern" });
      }
      fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__register_class_parent_ref") ?? refRegIdx });
      return;
    }
  }
  const t = compileExpression(ctx, fctx, heritageExpr);
  if (t === null) {
    fctx.body.push({ op: "drop" });
    return;
  }
  coerceType(ctx, fctx, t, { kind: "externref" });
  const finalRegIdx = ctx.funcMap.get("__register_class_parent") ?? regIdx;
  fctx.body.push({ op: "call", funcIdx: finalRegIdx });
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
  paramOffset = 0,
): void {
  const paramTypes = getFuncParamTypes(ctx, funcIdx);

  if (restInfo) {
    // Calling a rest-param function with spread — compile non-rest args normally,
    // then for the rest portion, if it's a single spread of an array, pass directly
    let argIdx = 0;
    for (let i = 0; i < restInfo.restIndex; i++) {
      if (argIdx < expr.arguments.length) {
        compileExpression(ctx, fctx, expr.arguments[argIdx]!, paramTypes?.[paramOffset + i]);
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
  // A direct instance-method call has already pushed its receiver into formal
  // slot 0 before expanding the user-visible spread arguments. Identifier and
  // constructor calls keep the default offset of zero.
  let paramIdx = paramOffset;
  for (let argPos = 0; argPos < args.length; argPos++) {
    const arg = args[argPos]!;
    if (ts.isSpreadElement(arg)) {
      // Compile the spread source (vec struct)
      const vecType = compileExpression(ctx, fctx, arg.expression);
      if (!vecType) continue;

      // An indexed read from an evolving / class-field array can preserve the
      // nested route tuple only as externref even though the runtime value is a
      // real vec. Expand it through the generic index bridge instead of
      // treating the whole tuple as formal 0 and padding the remaining
      // parameters. Hono's SmartRouter uses exactly this shape:
      // `router.add(...this.#routes[i])`.
      if (vecType.kind === "externref" && !ctx.standalone && !ctx.wasi) {
        ensureLateImport(ctx, "__extern_get_idx", [{ kind: "externref" }, { kind: "f64" }], [{ kind: "externref" }]);
        flushLateImportShifts(ctx, fctx);
        const getIdx = ctx.funcMap.get("__extern_get_idx");
        if (getIdx === undefined) {
          fctx.body.push({ op: "drop" });
          continue;
        }
        const vecLocal = allocLocal(fctx, `__spread_extern_${fctx.locals.length}`, { kind: "externref" });
        fctx.body.push({ op: "local.set", index: vecLocal });
        const reservedForTrailing = trailingPositionalAfter[argPos] ?? 0;
        const remainingParams = Math.max(0, paramTypes.length - paramIdx - reservedForTrailing);
        for (let i = 0; i < remainingParams; i++) {
          fctx.body.push({ op: "local.get", index: vecLocal });
          fctx.body.push({ op: "f64.const", value: i });
          fctx.body.push({ op: "call", funcIdx: getIdx });
          const expectedParamType = paramTypes[paramIdx];
          if (expectedParamType && expectedParamType.kind !== "externref") {
            coerceType(ctx, fctx, { kind: "externref" }, expectedParamType);
          }
          paramIdx++;
        }
        continue;
      }

      // A bail-out from here on must not strand the compiled source on the
      // stack: an unconsumed operand under the call is invalid Wasm (#5093).
      if (vecType.kind !== "ref" && vecType.kind !== "ref_null") {
        fctx.body.push({ op: "drop" });
        continue;
      }

      const vecTypeDef = ctx.mod.types[vecType.typeIdx];
      if (!vecTypeDef || vecTypeDef.kind !== "struct") {
        fctx.body.push({ op: "drop" });
        continue;
      }

      // (#5093) An inline array literal with statically-known elements lowers
      // to a TUPLE struct (`_0`, `_1`, …), not a `__vec_`: `getArrTypeIdxFromVec`
      // fails on it, so `...[7, 8]` used to contribute NO argument at all —
      // silently mis-binding the formals (`method(a, b)` took its `b` from the
      // NEXT spread) and, when nothing else filled the slot, emitting a call
      // with too few operands. Its arity is static, so expand it by field.
      // `emitSetExtrasArgv` recognises the same carrier for the extras list.
      const tupleFields = tupleStructFields(ctx, vecType.typeIdx);
      if (tupleFields) {
        const tupleLocal = allocLocal(fctx, `__spread_tuple_${fctx.locals.length}`, vecType);
        fctx.body.push({ op: "local.set", index: tupleLocal });
        const reservedAfterTuple = trailingPositionalAfter[argPos] ?? 0;
        const tupleSlots = Math.min(tupleFields.length, Math.max(0, paramTypes.length - paramIdx - reservedAfterTuple));
        for (let fi = 0; fi < tupleSlots; fi++) {
          fctx.body.push({ op: "local.get", index: tupleLocal });
          if (vecType.kind === "ref_null") fctx.body.push({ op: "ref.as_non_null" });
          fctx.body.push({ op: "struct.get", typeIdx: vecType.typeIdx, fieldIdx: fi });
          const fieldType = tupleFields[fi]!.type;
          const expectedParamType = paramTypes[paramIdx];
          if (expectedParamType && !valTypesMatch(fieldType, expectedParamType)) {
            coerceType(ctx, fctx, fieldType, expectedParamType);
          }
          paramIdx++;
        }
        continue;
      }

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

  // (#5093) The loop fills parameter slots opportunistically — a spread source
  // the vec/tuple readers cannot expand, or one whose static arity is shorter
  // than the formal list, leaves the tail unfilled. A call with fewer operands
  // than the callee's arity does not VALIDATE, so the module is rejected at
  // instantiation rather than merely returning a wrong value. Pad the rest the
  // way every non-spread call site does. Callers of this function never pad
  // afterwards, so this cannot double-fill.
  for (; paramIdx < paramTypes.length; paramIdx++) {
    pushDefaultValue(fctx, paramTypes[paramIdx]!, ctx);
  }
}

export {
  compileExternMethodCall,
  compileSpreadCallArgs,
  defaultValueInstrForType,
  patchStructNewForDynamicField,
  patchStructNewInBody,
};
