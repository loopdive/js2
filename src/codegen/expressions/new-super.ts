import type { FieldDef, Instr, ValType } from "../../ir/types.js";
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * new/super/class expression compilation.
 */
import { isSymbolType } from "../../checker/type-mapper.js";
import { forEachChild, ts } from "../../ts-api.js";
import {
  collectReferencedIdentifiers,
  collectWrittenIdentifiers,
  emitFuncRefAsClosure,
  isOwnParamName,
} from "../closures.js";
import { reportError } from "../context/errors.js";
import { allocLocal, allocTempLocal, releaseTempLocal } from "../context/locals.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import {
  addFuncType,
  addStringConstantGlobal,
  addUnionImports,
  ensureExnTag,
  getArrTypeIdxFromVec,
  getOrRegisterRefCellType,
  getOrRegisterVecType,
  resolveWasmType,
} from "../index.js";
import { ensureMapHelpers } from "../map-runtime.js";
import { emitSetNewTargetBeforeCall, ensureNewTargetGlobal } from "../new-target.js"; // (#2023)
import { ensureObjectRuntime } from "../object-runtime.js"; // (#1100) standalone Proxy native runtime
import { ensureSetHelpers } from "../set-runtime.js";
import { ensureWeakCollectionHelpers } from "../weak-collections-runtime.js";
import { classMemberFuncKey } from "../class-member-keys.js"; // (#1983) collision-free class-member funcMap keys
import { compileObjectLiteralAsExternref, resolveComputedKeyExpression } from "../literals.js";
import { stringConstantExternrefInstrs } from "../native-strings.js";
import {
  compileStandaloneRegExpConstructor,
  isGlobalRegExpIdentifier,
  isGlobalRegExpType,
} from "../regexp-standalone.js";
import { emitWasiErrorConstructor, isWasiErrorName } from "../registry/error-types.js";
import type { InnerResult } from "../shared.js";
import {
  coerceType,
  compileExpression,
  compileStatement,
  registerCompileSuperElementAccess,
  registerCompileSuperPropertyAccess,
  registerResolveEnclosingClassName,
} from "../shared.js";
import { maybeSetArgcForKnownCall } from "../statements/nested-declarations.js";
import { compileStringLiteral } from "../string-ops.js";
import { coerceType as coerceTypeImpl, pushDefaultValue } from "../type-coercion.js";
import { ensureDateDaysFromCivilHelper, ensureDateStruct } from "./builtins.js";
import { compileSpreadCallArgs } from "./extern.js";
import { compileTemporalNewExpression } from "../temporal-native.js";
import {
  emitThrowReferenceError,
  emitThrowString,
  emitThrowTypeError,
  getFuncParamTypes,
  getWasmFuncReturnType,
  isEffectivelyVoidReturn,
  noJsHost,
  wasmFuncReturnsVoid,
} from "./helpers.js";
import { localGlobalIdx } from "../registry/imports.js";
import { ensureLateImport, flushLateImportShifts } from "./late-imports.js";

function resolveEnclosingClassName(fctx: FunctionContext): string | undefined {
  if (fctx.enclosingClassName) return fctx.enclosingClassName;
  const underscoreIdx = fctx.name.indexOf("_");
  if (underscoreIdx > 0) return fctx.name.substring(0, underscoreIdx);
  return undefined;
}

function valTypeMatches(a: ValType, b: ValType): boolean {
  if (a.kind !== b.kind) return false;
  if ((a.kind === "ref" || a.kind === "ref_null") && (b.kind === "ref" || b.kind === "ref_null")) {
    return a.typeIdx === b.typeIdx;
  }
  return true;
}

function compileCtorArgument(ctx: CodegenContext, fctx: FunctionContext, arg: ts.Expression, expected?: ValType): void {
  const result = compileExpression(ctx, fctx, arg, expected);
  if (result === null) {
    if (expected) pushDefaultValue(fctx, expected, ctx);
    return;
  }
  if (expected && !valTypeMatches(result, expected)) {
    coerceType(ctx, fctx, result, expected);
  }
}

function evaluateCtorExtraArgument(ctx: CodegenContext, fctx: FunctionContext, arg: ts.Expression): void {
  const result = compileExpression(ctx, fctx, arg);
  if (result !== null) {
    fctx.body.push({ op: "drop" });
  }
}

/**
 * (#1732 S1) Decide whether a `new <id>` callee identifier resolves to a value
 * that is PROVABLY not a constructor — so the runtime `__construct` brand check
 * can be emitted without risk of intercepting a real constructor.
 *
 * Returns true only when the identifier's (variable/parameter) declaration has
 * an initializer that is a known-non-constructable expression shape:
 *   - `<expr>.prototype.<method>` — builtin/user prototype methods never have
 *     [[Construct]] (§20.x / §10.2.2). This is the `S15.5.4.*_A7` pattern
 *     (`var f = String.prototype.indexOf; new f`).
 *   - `<expr>.bind(...)` / `.call(...)` / `.apply(...)` — bound functions are
 *     non-constructors unless the target is (and the result of `.call`/`.apply`
 *     is a plain value, never a constructor).
 *
 * Deliberately conservative: any other initializer shape (function expression,
 * class reference, plain identifier, call to a factory, etc.) returns false so
 * those keep the existing static / unknown-ctor handling. User function
 * declarations are resolved earlier (2414-2469) and never reach the caller.
 */
function resolvesToNonConstructableValue(ctx: CodegenContext, calleeExpr: ts.Expression): boolean {
  if (!ts.isIdentifier(calleeExpr)) return false;
  const sym = ctx.checker.getSymbolAtLocation(calleeExpr);
  const decls = sym?.getDeclarations();
  if (!decls || decls.length === 0) return false;

  const isNonConstructableInit = (init: ts.Expression): boolean => {
    // Unwrap as/paren/non-null wrappers.
    let e: ts.Expression = init;
    while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e)) {
      e = ts.isParenthesizedExpression(e)
        ? e.expression
        : ts.isAsExpression(e)
          ? e.expression
          : (e as ts.NonNullExpression).expression;
    }
    // `<...>.prototype.<method>` — a method pulled off a prototype.
    if (ts.isPropertyAccessExpression(e)) {
      const obj = e.expression;
      if (ts.isPropertyAccessExpression(obj) && obj.name.text === "prototype") return true;
    }
    // `<...>.bind(...)` / `.call(...)` / `.apply(...)` result.
    if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression)) {
      const m = e.expression.name.text;
      if (m === "bind" || m === "call" || m === "apply") return true;
    }
    return false;
  };

  for (const decl of decls) {
    // `var/let/const f = <init>`
    if (ts.isVariableDeclaration(decl) && decl.initializer) {
      if (isNonConstructableInit(decl.initializer)) return true;
    }
  }
  return false;
}

/** Compile super.method(args) — resolve to ParentClass_method and call with this */
/**
 * (#1614) Dispatch `super.method(args)` where the parent is a builtin extern
 * class (Set/Map/Array/...) whose methods are host-backed and therefore not
 * present in `funcMap`. Emits __extern_method_call(this, methodName, argsArray)
 * and returns externref. Returns null when the parent is not a known extern
 * class or the required host imports cannot be registered (caller then reports
 * the original "Cannot find method" error).
 */
function emitSuperExternMethodCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  methodName: string,
  parentClassName: string,
): ValType | null {
  // Only applies when the parent (or an ancestor) is a registered extern class.
  let externAncestor: string | undefined = parentClassName;
  while (externAncestor && !ctx.externClasses.has(externAncestor)) {
    externAncestor = ctx.classParentMap.get(externAncestor);
  }
  if (!externAncestor) return null;

  const selfIdx = fctx.localMap.get("this");
  if (selfIdx === undefined) return null;

  const arrNewIdx = ensureLateImport(ctx, "__js_array_new", [], [{ kind: "externref" }]);
  const arrPushIdx = ensureLateImport(ctx, "__js_array_push", [{ kind: "externref" }, { kind: "externref" }], []);
  const methodCallIdx = ensureLateImport(
    ctx,
    "__extern_method_call",
    [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
    [{ kind: "externref" }],
  );
  flushLateImportShifts(ctx, fctx);
  if (arrNewIdx === undefined || arrPushIdx === undefined || methodCallIdx === undefined) return null;

  // Receiver = `this`, coerced to externref.
  fctx.body.push({ op: "local.get", index: selfIdx });
  fctx.body.push({ op: "extern.convert_any" });
  const recvLocal = allocLocal(fctx, `__super_emc_recv_${fctx.locals.length}`, {
    kind: "externref",
  });
  fctx.body.push({ op: "local.set", index: recvLocal });

  // Build args array.
  fctx.body.push({ op: "call", funcIdx: arrNewIdx });
  const argsLocal = allocLocal(fctx, `__super_emc_args_${fctx.locals.length}`, {
    kind: "externref",
  });
  fctx.body.push({ op: "local.set", index: argsLocal });

  for (const arg of expr.arguments) {
    const valueExpr = ts.isSpreadElement(arg) ? arg.expression : arg;
    fctx.body.push({ op: "local.get", index: argsLocal });
    const argType = compileExpression(ctx, fctx, valueExpr, {
      kind: "externref",
    });
    if (argType && argType.kind !== "externref") {
      fctx.body.push({ op: "extern.convert_any" });
    } else if (argType === null) {
      fctx.body.push({ op: "ref.null.extern" });
    }
    const finalPushIdx = ctx.funcMap.get("__js_array_push") ?? arrPushIdx;
    fctx.body.push({ op: "call", funcIdx: finalPushIdx });
  }

  // __extern_method_call(receiver, methodName, args)
  fctx.body.push({ op: "local.get", index: recvLocal });
  addStringConstantGlobal(ctx, methodName);
  const strIdx = ctx.stringGlobalMap.get(methodName);
  if (strIdx !== undefined) {
    fctx.body.push({ op: "global.get", index: strIdx } as Instr);
  } else {
    compileStringLiteral(ctx, fctx, methodName);
  }
  fctx.body.push({ op: "local.get", index: argsLocal });
  const finalMcIdx = ctx.funcMap.get("__extern_method_call") ?? methodCallIdx;
  fctx.body.push({ op: "call", funcIdx: finalMcIdx });
  return { kind: "externref" };
}

function compileSuperMethodCall(ctx: CodegenContext, fctx: FunctionContext, expr: ts.CallExpression): InnerResult {
  const propAccess = expr.expression as ts.PropertyAccessExpression;
  const methodName = propAccess.name.text;

  // Determine which class we're in
  const currentClassName = resolveEnclosingClassName(fctx);
  if (!currentClassName) {
    // super.method() in object literal — evaluate args for side effects, return default
    for (const arg of expr.arguments) {
      const argType = compileExpression(ctx, fctx, arg);
      if (argType !== null) fctx.body.push({ op: "drop" });
    }
    const sig = ctx.checker.getResolvedSignature(expr);
    if (sig) {
      const retType = ctx.checker.getReturnTypeOfSignature(sig);
      const wasmType = resolveWasmType(ctx, retType);
      if (wasmType.kind === "f64") {
        fctx.body.push({ op: "f64.const", value: 0 });
      } else if (wasmType.kind === "i32") {
        fctx.body.push({ op: "i32.const", value: 0 });
      } else {
        fctx.body.push({ op: "ref.null.extern" });
      }
      return wasmType;
    }
    return null;
  }

  // Find parent class
  const parentClassName = ctx.classParentMap.get(currentClassName);
  if (!parentClassName) {
    // super.method() in class without extends — no parent to resolve.
    // Evaluate args for side effects, return default value.
    for (const arg of expr.arguments) {
      const argType = compileExpression(ctx, fctx, arg);
      if (argType !== null) fctx.body.push({ op: "drop" });
    }
    const sig = ctx.checker.getResolvedSignature(expr);
    if (sig) {
      const retType = ctx.checker.getReturnTypeOfSignature(sig);
      const wasmType = resolveWasmType(ctx, retType);
      if (wasmType.kind === "f64") {
        fctx.body.push({ op: "f64.const", value: 0 });
      } else if (wasmType.kind === "i32") {
        fctx.body.push({ op: "i32.const", value: 0 });
      } else {
        fctx.body.push({ op: "ref.null.extern" });
      }
      return wasmType;
    }
    return null;
  }

  // Resolve parent method — walk up the inheritance chain
  let ancestor: string | undefined = parentClassName;
  let funcIdx: number | undefined;
  while (ancestor) {
    funcIdx = ctx.funcMap.get(`${ancestor}_${methodName}`);
    if (funcIdx !== undefined) break;
    ancestor = ctx.classParentMap.get(ancestor);
  }

  if (funcIdx === undefined) {
    // (#1614) The parent may be a builtin extern class (Set/Map/Array/...)
    // whose methods are host-backed, not compiled into funcMap. Dispatch
    // `super.method(args)` dynamically via __extern_method_call(this, name, args).
    const externResult = emitSuperExternMethodCall(ctx, fctx, expr, methodName, parentClassName);
    if (externResult !== null) return externResult;
    reportError(ctx, expr, `Cannot find method '${methodName}' on parent class '${parentClassName}'`);
    return null;
  }

  // Push this as first argument
  const selfIdx = fctx.localMap.get("this");
  if (selfIdx !== undefined) {
    fctx.body.push({ op: "local.get", index: selfIdx });
  }

  // Push remaining arguments with type hints
  const paramTypes = getFuncParamTypes(ctx, funcIdx);
  // User-visible param count excludes self (param 0)
  const superParamCount = paramTypes ? paramTypes.length - 1 : expr.arguments.length;
  for (let i = 0; i < expr.arguments.length; i++) {
    if (i < superParamCount) {
      compileExpression(ctx, fctx, expr.arguments[i]!, paramTypes?.[i + 1]); // +1 to skip self
    } else {
      // Extra argument beyond method's parameter count — evaluate for
      // side effects (JS semantics) and discard the result
      const extraType = compileExpression(ctx, fctx, expr.arguments[i]!);
      if (extraType !== null) {
        fctx.body.push({ op: "drop" });
      }
    }
  }
  // Pad missing arguments with defaults (skip self param at index 0)
  if (paramTypes) {
    for (let i = expr.arguments.length + 1; i < paramTypes.length; i++) {
      pushDefaultValue(fctx, paramTypes[i]!, ctx);
    }
  }
  // Re-lookup funcIdx: argument compilation may trigger addUnionImports
  const resolvedName = `${ancestor}_${methodName}`;
  const finalSuperIdx = ctx.funcMap.get(resolvedName) ?? funcIdx;
  maybeSetArgcForKnownCall(ctx, fctx, resolvedName, expr.arguments.length, superParamCount);
  fctx.body.push({ op: "call", funcIdx: finalSuperIdx });

  // Determine return type
  const sig = ctx.checker.getResolvedSignature(expr);
  if (sig) {
    const retType = ctx.checker.getReturnTypeOfSignature(sig);
    if (isEffectivelyVoidReturn(ctx, retType, resolvedName)) return null;
    if (wasmFuncReturnsVoid(ctx, finalSuperIdx)) return null;
    return getWasmFuncReturnType(ctx, finalSuperIdx) ?? resolveWasmType(ctx, retType);
  }
  return null;
}

/**
 * Compile `super['method'](args)` — resolve to ParentClass_method and call with this.
 * Same logic as compileSuperMethodCall but the method name comes from a computed key.
 */
function compileSuperElementMethodCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  methodName: string,
): ValType | null {
  // Determine which class we're in
  const currentClassName = resolveEnclosingClassName(fctx);
  if (!currentClassName) {
    // super['method']() in object literal — evaluate args, return default
    for (const arg of expr.arguments) {
      const argType = compileExpression(ctx, fctx, arg);
      if (argType !== null) fctx.body.push({ op: "drop" });
    }
    return null;
  }

  // Find parent class
  const parentClassName = ctx.classParentMap.get(currentClassName);
  if (!parentClassName) {
    // super['method']() in class without extends — evaluate args, return default
    for (const arg of expr.arguments) {
      const argType = compileExpression(ctx, fctx, arg);
      if (argType !== null) fctx.body.push({ op: "drop" });
    }
    return null;
  }

  // Resolve parent method — walk up the inheritance chain
  let ancestor: string | undefined = parentClassName;
  let funcIdx: number | undefined;
  while (ancestor) {
    funcIdx = ctx.funcMap.get(`${ancestor}_${methodName}`);
    if (funcIdx !== undefined) break;
    ancestor = ctx.classParentMap.get(ancestor);
  }

  if (funcIdx === undefined) {
    // (#1614) Builtin extern-class parent — dispatch dynamically.
    const externResult = emitSuperExternMethodCall(ctx, fctx, expr, methodName, parentClassName);
    if (externResult !== null) return externResult;
    reportError(ctx, expr, `Cannot find method '${methodName}' on parent class '${parentClassName}'`);
    return null;
  }

  // Push this as first argument
  const selfIdx = fctx.localMap.get("this");
  if (selfIdx !== undefined) {
    fctx.body.push({ op: "local.get", index: selfIdx });
  }

  // Push remaining arguments with type hints
  const paramTypes = getFuncParamTypes(ctx, funcIdx);
  // User-visible param count excludes self (param 0)
  const superElemParamCount = paramTypes ? paramTypes.length - 1 : expr.arguments.length;
  for (let i = 0; i < expr.arguments.length; i++) {
    if (i < superElemParamCount) {
      compileExpression(ctx, fctx, expr.arguments[i]!, paramTypes?.[i + 1]); // +1 to skip self
    } else {
      // Extra argument beyond method's parameter count — evaluate for
      // side effects (JS semantics) and discard the result
      const extraType = compileExpression(ctx, fctx, expr.arguments[i]!);
      if (extraType !== null) {
        fctx.body.push({ op: "drop" });
      }
    }
  }
  // Pad missing arguments with defaults (skip self param at index 0)
  if (paramTypes) {
    for (let i = expr.arguments.length + 1; i < paramTypes.length; i++) {
      pushDefaultValue(fctx, paramTypes[i]!, ctx);
    }
  }
  // Re-lookup funcIdx: argument compilation may trigger addUnionImports
  const resolvedName = `${ancestor}_${methodName}`;
  const finalSuperIdx = ctx.funcMap.get(resolvedName) ?? funcIdx;
  maybeSetArgcForKnownCall(ctx, fctx, resolvedName, expr.arguments.length, superElemParamCount);
  fctx.body.push({ op: "call", funcIdx: finalSuperIdx });

  // Determine return type
  const sig = ctx.checker.getResolvedSignature(expr);
  if (sig) {
    const retType = ctx.checker.getReturnTypeOfSignature(sig);
    if (isEffectivelyVoidReturn(ctx, retType, resolvedName)) return null;
    if (wasmFuncReturnsVoid(ctx, finalSuperIdx)) return null;
    return getWasmFuncReturnType(ctx, finalSuperIdx) ?? resolveWasmType(ctx, retType);
  }
  return null;
}

/**
 * Compile `super.prop` — access a parent class property or getter via `this`.
 * For getter accessors, calls the parent's getter function.
 * For struct fields, accesses the field on `this` (child struct inherits parent fields).
 */
export function compileSuperPropertyAccess(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PropertyAccessExpression,
  propName: string,
): ValType | null {
  // Determine which class we're in
  const currentClassName = resolveEnclosingClassName(fctx);
  if (!currentClassName) {
    // super in object literal method — cannot resolve prototype chain at compile time.
    // Emit a default value based on the access type.
    const accessType = ctx.checker.getTypeAtLocation(expr);
    const wasmType = resolveWasmType(ctx, accessType);
    if (wasmType.kind === "f64") {
      fctx.body.push({ op: "f64.const", value: 0 });
    } else if (wasmType.kind === "i32") {
      fctx.body.push({ op: "i32.const", value: 0 });
    } else {
      fctx.body.push({ op: "ref.null.extern" });
    }
    return wasmType;
  }

  // Find parent class — if none, super resolves to Object.prototype (most props undefined)
  const parentClassName = ctx.classParentMap.get(currentClassName);
  if (!parentClassName) {
    // In a base class, super.prop resolves to Object.prototype[prop] — usually undefined.
    const accessType = ctx.checker.getTypeAtLocation(expr);
    const wasmType = resolveWasmType(ctx, accessType);
    if (wasmType.kind === "f64") {
      fctx.body.push({ op: "f64.const", value: 0 });
    } else if (wasmType.kind === "i32") {
      fctx.body.push({ op: "i32.const", value: 0 });
    } else {
      fctx.body.push({ op: "ref.null.extern" });
    }
    return wasmType;
  }

  // Check for parent getter accessor — walk up inheritance chain
  let ancestor: string | undefined = parentClassName;
  while (ancestor) {
    const accessorKey = `${ancestor}_${propName}`;
    if (ctx.classAccessorSet.has(accessorKey)) {
      const getterName = `${ancestor}_get_${propName}`;
      const funcIdx = ctx.funcMap.get(getterName);
      if (funcIdx !== undefined) {
        // Push this as argument to the getter
        const selfIdx = fctx.localMap.get("this");
        if (selfIdx !== undefined) {
          fctx.body.push({ op: "local.get", index: selfIdx });
        }
        fctx.body.push({ op: "call", funcIdx });
        const propType = ctx.checker.getTypeAtLocation(expr);
        return resolveWasmType(ctx, propType);
      }
    }
    ancestor = ctx.classParentMap.get(ancestor);
  }

  // Fall back to struct field access on `this` — child struct includes parent fields
  // Walk up to find which ancestor defines this field
  ancestor = parentClassName;
  while (ancestor) {
    const structTypeIdx = ctx.structMap.get(ancestor);
    const fields = ctx.structFields.get(ancestor);
    if (structTypeIdx !== undefined && fields) {
      const fieldIdx = fields.findIndex((f) => f.name === propName);
      if (fieldIdx !== -1) {
        // Use the current class's struct since it inherits all parent fields
        const currentStructTypeIdx = ctx.structMap.get(currentClassName);
        const currentFields = ctx.structFields.get(currentClassName);
        if (currentStructTypeIdx !== undefined && currentFields) {
          const currentFieldIdx = currentFields.findIndex((f) => f.name === propName);
          if (currentFieldIdx !== -1) {
            const selfIdx = fctx.localMap.get("this");
            if (selfIdx !== undefined) {
              fctx.body.push({ op: "local.get", index: selfIdx });
            }
            fctx.body.push({
              op: "struct.get",
              typeIdx: currentStructTypeIdx,
              fieldIdx: currentFieldIdx,
            });
            return currentFields[currentFieldIdx]!.type;
          }
        }
        // If not found in current, try parent struct directly
        const selfIdx = fctx.localMap.get("this");
        if (selfIdx !== undefined) {
          fctx.body.push({ op: "local.get", index: selfIdx });
        }
        fctx.body.push({
          op: "struct.get",
          typeIdx: structTypeIdx,
          fieldIdx,
        });
        return fields[fieldIdx]!.type;
      }
    }
    ancestor = ctx.classParentMap.get(ancestor);
  }

  // Fallback: could be a method reference (not a call) — try to find a parent method
  // For now, emit a default based on the TypeScript type at the access site
  const accessType = ctx.checker.getTypeAtLocation(expr);
  const wasmType = resolveWasmType(ctx, accessType);
  if (wasmType.kind === "f64") {
    fctx.body.push({ op: "f64.const", value: 0 });
  } else if (wasmType.kind === "i32") {
    fctx.body.push({ op: "i32.const", value: 0 });
  } else {
    fctx.body.push({ op: "ref.null.extern" });
  }
  return wasmType;
}

/**
 * Compile `super[expr]` — access a parent class property via computed key on `this`.
 * Resolves the key at compile time if possible and delegates to compileSuperPropertyAccess logic.
 * For dynamic keys, falls back to default value for the access type.
 */
export function compileSuperElementAccess(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.ElementAccessExpression,
): ValType | null {
  const argExpr = expr.argumentExpression;
  // Try to resolve the key to a static string
  let propName: string | undefined;
  if (argExpr) {
    if (ts.isStringLiteral(argExpr)) {
      propName = argExpr.text;
    } else if (ts.isNumericLiteral(argExpr)) {
      propName = String(Number(argExpr.text));
    } else {
      propName = resolveComputedKeyExpression(ctx, argExpr);
    }
  }

  if (propName === undefined) {
    // Dynamic key on super — cannot resolve at compile time
    // Emit default value for the access type
    const accessType = ctx.checker.getTypeAtLocation(expr);
    const wasmType = resolveWasmType(ctx, accessType);
    if (wasmType.kind === "f64") {
      fctx.body.push({ op: "f64.const", value: 0 });
    } else if (wasmType.kind === "i32") {
      fctx.body.push({ op: "i32.const", value: 0 });
    } else {
      fctx.body.push({ op: "ref.null.extern" });
    }
    return wasmType;
  }

  // Determine which class we're in
  const currentClassName = resolveEnclosingClassName(fctx);
  if (!currentClassName) {
    // super in object literal method — emit default value
    const accessType2 = ctx.checker.getTypeAtLocation(expr);
    const wasmType2 = resolveWasmType(ctx, accessType2);
    if (wasmType2.kind === "f64") {
      fctx.body.push({ op: "f64.const", value: 0 });
    } else if (wasmType2.kind === "i32") {
      fctx.body.push({ op: "i32.const", value: 0 });
    } else {
      fctx.body.push({ op: "ref.null.extern" });
    }
    return wasmType2;
  }

  // Find parent class — if none, super resolves to Object.prototype
  const parentClassName = ctx.classParentMap.get(currentClassName);
  if (!parentClassName) {
    const accessType2 = ctx.checker.getTypeAtLocation(expr);
    const wasmType2 = resolveWasmType(ctx, accessType2);
    if (wasmType2.kind === "f64") {
      fctx.body.push({ op: "f64.const", value: 0 });
    } else if (wasmType2.kind === "i32") {
      fctx.body.push({ op: "i32.const", value: 0 });
    } else {
      fctx.body.push({ op: "ref.null.extern" });
    }
    return wasmType2;
  }

  // Check for parent getter accessor — walk up inheritance chain
  let ancestor: string | undefined = parentClassName;
  while (ancestor) {
    const accessorKey = `${ancestor}_${propName}`;
    if (ctx.classAccessorSet.has(accessorKey)) {
      const getterName = `${ancestor}_get_${propName}`;
      const funcIdx = ctx.funcMap.get(getterName);
      if (funcIdx !== undefined) {
        const selfIdx = fctx.localMap.get("this");
        if (selfIdx !== undefined) {
          fctx.body.push({ op: "local.get", index: selfIdx });
        }
        fctx.body.push({ op: "call", funcIdx });
        const propType = ctx.checker.getTypeAtLocation(expr);
        return resolveWasmType(ctx, propType);
      }
    }
    ancestor = ctx.classParentMap.get(ancestor);
  }

  // Fall back to struct field access on `this`
  ancestor = parentClassName;
  while (ancestor) {
    const structTypeIdx = ctx.structMap.get(ancestor);
    const fields = ctx.structFields.get(ancestor);
    if (structTypeIdx !== undefined && fields) {
      const fieldIdx = fields.findIndex((f) => f.name === propName);
      if (fieldIdx !== -1) {
        const currentStructTypeIdx = ctx.structMap.get(currentClassName);
        const currentFields = ctx.structFields.get(currentClassName);
        if (currentStructTypeIdx !== undefined && currentFields) {
          const currentFieldIdx = currentFields.findIndex((f) => f.name === propName);
          if (currentFieldIdx !== -1) {
            const selfIdx = fctx.localMap.get("this");
            if (selfIdx !== undefined) {
              fctx.body.push({ op: "local.get", index: selfIdx });
            }
            fctx.body.push({
              op: "struct.get",
              typeIdx: currentStructTypeIdx,
              fieldIdx: currentFieldIdx,
            });
            return currentFields[currentFieldIdx]!.type;
          }
        }
        const selfIdx = fctx.localMap.get("this");
        if (selfIdx !== undefined) {
          fctx.body.push({ op: "local.get", index: selfIdx });
        }
        fctx.body.push({
          op: "struct.get",
          typeIdx: structTypeIdx,
          fieldIdx,
        });
        return fields[fieldIdx]!.type;
      }
    }
    ancestor = ctx.classParentMap.get(ancestor);
  }

  // Fallback: emit default value based on TypeScript type
  const accessType = ctx.checker.getTypeAtLocation(expr);
  const wasmType = resolveWasmType(ctx, accessType);
  if (wasmType.kind === "f64") {
    fctx.body.push({ op: "f64.const", value: 0 });
  } else if (wasmType.kind === "i32") {
    fctx.body.push({ op: "i32.const", value: 0 });
  } else {
    fctx.body.push({ op: "ref.null.extern" });
  }
  return wasmType;
}

/**
 * Infer the element type of an untyped `new Array()` by scanning how the
 * target variable is used. Walks the enclosing function body for element
 * assignments (arr[i] = value) and push calls (arr.push(value)), then
 * returns the TS element type of the first concrete (non-any) value found.
 */
function inferArrayElementType(ctx: CodegenContext, expr: ts.NewExpression): ts.Type | null {
  // Find the variable name this `new Array()` is assigned to.
  // Pattern: `var x = new Array()` or `var x: T = new Array()`
  const parent = expr.parent;
  let varName: string | null = null;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    varName = parent.name.text;
  } else if (
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isIdentifier(parent.left)
  ) {
    varName = parent.left.text;
  }
  if (!varName) return null;

  // Walk up to the enclosing function body or source file
  let scope: ts.Node = expr;
  while (
    scope &&
    !ts.isFunctionDeclaration(scope) &&
    !ts.isFunctionExpression(scope) &&
    !ts.isArrowFunction(scope) &&
    !ts.isMethodDeclaration(scope) &&
    !ts.isSourceFile(scope)
  ) {
    scope = scope.parent;
  }
  if (!scope) return null;

  let inferredElemType: ts.Type | null = null;

  function visit(node: ts.Node) {
    if (inferredElemType) return; // already found

    // arr[i] = value
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isElementAccessExpression(node.left) &&
      ts.isIdentifier(node.left.expression) &&
      node.left.expression.text === varName
    ) {
      const valType = ctx.checker.getTypeAtLocation(node.right);
      if (!(valType.flags & ts.TypeFlags.Any)) {
        inferredElemType = valType;
        return;
      }
    }

    // arr.push(value)
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "push" &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === varName &&
      node.arguments.length >= 1
    ) {
      const valType = ctx.checker.getTypeAtLocation(node.arguments[0]!);
      if (!(valType.flags & ts.TypeFlags.Any)) {
        inferredElemType = valType;
        return;
      }
    }

    forEachChild(node, visit);
  }

  visit(scope);
  return inferredElemType;
}

/**
 * Check if a node tree references the `arguments` identifier.
 * Skips nested function declarations and function expressions (which have
 * their own `arguments` binding), but traverses into arrow functions
 * because arrows inherit the enclosing function's `arguments`.
 */
function usesArguments(node: ts.Node): boolean {
  if (ts.isIdentifier(node) && node.text === "arguments") return true;
  if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) {
    return false;
  }
  return forEachChild(node, usesArguments) ?? false;
}

/**
 * Flatten call-site arguments, expanding spread elements on array literals
 * into individual expressions. Returns the flat list of expressions.
 * For spread on non-literal arrays, returns null (cannot flatten at compile time).
 */
function flattenCallArgs(args: readonly ts.Expression[]): ts.Expression[] | null {
  const result: ts.Expression[] = [];
  for (const arg of args) {
    if (ts.isSpreadElement(arg)) {
      if (ts.isArrayLiteralExpression(arg.expression)) {
        // Spread on array literal: inline elements
        for (const el of arg.expression.elements) {
          result.push(el);
        }
      } else {
        // Spread on non-literal — can't flatten at compile time
        return null;
      }
    } else {
      result.push(arg);
    }
  }
  return result;
}

/**
 * Compile `new FuncDecl(args)` where FuncDecl is a function declaration used
 * as a constructor (e.g. `function Foo() { this.x = 1; }; new Foo()`).
 *
 * Strategy:
 * 1. Analyze the function body for `this.prop = value` assignments to determine struct fields.
 * 2. Create a WasmGC struct type with those fields.
 * 3. Create a constructor function that allocates the struct, binds `this`, runs the body, returns the struct.
 * 4. Cache the struct type and constructor so subsequent `new Foo()` calls reuse them.
 */
function compileNewFunctionDeclaration(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.NewExpression,
  funcName: string,
  funcDecl: ts.FunctionDeclaration,
): ValType | null {
  const body = funcDecl.body;
  if (!body) return null;

  // 1. Analyze the function body for `this.prop = value` assignments
  const fields: FieldDef[] = [];
  function collectThisAssignments(stmts: ts.NodeArray<ts.Statement> | readonly ts.Statement[]): void {
    for (const stmt of stmts) {
      if (
        ts.isExpressionStatement(stmt) &&
        ts.isBinaryExpression(stmt.expression) &&
        stmt.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(stmt.expression.left) &&
        stmt.expression.left.expression.kind === ts.SyntaxKind.ThisKeyword
      ) {
        const fieldName = stmt.expression.left.name.text;
        if (!fields.some((f) => f.name === fieldName)) {
          // Prefer the RHS type — when `this` is `any`, the LHS type is also `any`
          // (externref), but the RHS has concrete type info (e.g., number → f64).
          const lhsType = ctx.checker.getTypeAtLocation(stmt.expression.left);
          const rhsType = ctx.checker.getTypeAtLocation(stmt.expression.right);
          const lhsWasm = resolveWasmType(ctx, lhsType);
          const rhsWasm = resolveWasmType(ctx, rhsType);
          // Use RHS type if LHS resolved to externref (i.e., `any`)
          const fieldType = lhsWasm.kind === "externref" ? rhsWasm : lhsWasm;
          fields.push({ name: fieldName, type: fieldType, mutable: true });
        }
      }
      // Recurse into if/else blocks
      if (ts.isIfStatement(stmt)) {
        if (ts.isBlock(stmt.thenStatement)) {
          collectThisAssignments(stmt.thenStatement.statements);
        }
        if (stmt.elseStatement && ts.isBlock(stmt.elseStatement)) {
          collectThisAssignments(stmt.elseStatement.statements);
        }
      }
      // Recurse into for/while/do blocks
      if (
        (ts.isForStatement(stmt) ||
          ts.isForInStatement(stmt) ||
          ts.isForOfStatement(stmt) ||
          ts.isWhileStatement(stmt) ||
          ts.isDoStatement(stmt)) &&
        ts.isBlock(stmt.statement)
      ) {
        collectThisAssignments(stmt.statement.statements);
      }
    }
  }
  collectThisAssignments(body.statements);

  // Empty constructors (no this.prop assignments) — create an empty struct.
  // Many test262 tests define `var Con = function() {}; new Con()` to test
  // prototype-based inheritance. We emit a minimal struct + constructor.

  // Widen non-null ref fields to ref_null so struct.new can use ref.null defaults
  for (const field of fields) {
    if (field.type.kind === "ref") {
      field.type = {
        kind: "ref_null",
        typeIdx: (field.type as { typeIdx: number }).typeIdx,
      };
    }
  }

  // 2. Create a struct type for the function constructor
  const structName = `__fnctor_${funcName}`;
  const structTypeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: structName,
    fields,
  });
  ctx.structMap.set(structName, structTypeIdx);
  ctx.typeIdxToStructName.set(structTypeIdx, structName);
  ctx.structFields.set(structName, fields);

  // 3. Build the constructor function
  // Constructor params match the function declaration params
  const ctorParams: ValType[] = [];
  for (let i = 0; i < funcDecl.parameters.length; i++) {
    const param = funcDecl.parameters[i]!;
    const paramType = ctx.checker.getTypeAtLocation(param);
    ctorParams.push(resolveWasmType(ctx, paramType));
  }

  const ctorName = `${structName}_new`;
  const ctorResults: ValType[] = [{ kind: "ref", typeIdx: structTypeIdx }];
  const ctorTypeIdx = addFuncType(ctx, ctorParams, ctorResults, `${ctorName}_type`);
  const ctorFuncIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.funcMap.set(classMemberFuncKey(ctx, ctorName), ctorFuncIdx); // (#1983) collision-free key

  const ctorFunc = {
    name: ctorName,
    typeIdx: ctorTypeIdx,
    locals: [] as { name: string; type: ValType }[],
    body: [] as Instr[],
    exported: false,
  };
  ctx.mod.functions.push(ctorFunc);

  // Cache the mapping
  ctx.funcConstructorMap.set(funcName, {
    structTypeIdx,
    ctorFuncName: ctorName,
  });

  // 4. Compile the constructor body
  const paramDefs: { name: string; type: ValType }[] = [];
  for (let i = 0; i < funcDecl.parameters.length; i++) {
    const p = funcDecl.parameters[i]!;
    paramDefs.push({
      name: ts.isIdentifier(p.name) ? p.name.text : `__param${i}`,
      type: ctorParams[i] ?? { kind: "f64" },
    });
  }

  const ctorFctx: FunctionContext = {
    name: ctorName,
    params: paramDefs,
    locals: [],
    localMap: new Map(),
    returnType: { kind: "ref", typeIdx: structTypeIdx },
    body: [],
    blockDepth: 0,
    breakStack: [],
    continueStack: [],
    labelMap: new Map(),
    savedBodies: [],
  };

  // Set up param locals
  for (let i = 0; i < ctorFctx.params.length; i++) {
    ctorFctx.localMap.set(ctorFctx.params[i]!.name, i);
  }

  // Allocate the struct instance with default values
  for (const field of fields) {
    if (field.type.kind === "f64") {
      ctorFctx.body.push({ op: "f64.const", value: 0 });
    } else if (field.type.kind === "i32") {
      ctorFctx.body.push({ op: "i32.const", value: 0 });
    } else if (field.type.kind === "i64") {
      ctorFctx.body.push({ op: "i64.const", value: 0n });
    } else if (field.type.kind === "externref") {
      ctorFctx.body.push({ op: "ref.null.extern" });
    } else if (field.type.kind === "ref_null") {
      ctorFctx.body.push({
        op: "ref.null",
        typeIdx: (field.type as { typeIdx: number }).typeIdx,
      } as Instr);
    } else if (field.type.kind === "ref") {
      ctorFctx.body.push({
        op: "ref.null",
        typeIdx: (field.type as { typeIdx: number }).typeIdx,
      } as Instr);
    } else {
      ctorFctx.body.push({ op: "i32.const", value: 0 });
    }
  }
  ctorFctx.body.push({ op: "struct.new", typeIdx: structTypeIdx } as Instr);

  // Store in __self local
  const selfLocal = allocLocal(ctorFctx, "__self", {
    kind: "ref",
    typeIdx: structTypeIdx,
  });
  ctorFctx.body.push({ op: "local.set", index: selfLocal });

  // Bind `this` to the struct
  ctorFctx.localMap.set("this", selfLocal);

  // (#1712) Register the instance → constructor-closure link with the JS
  // host so instance property misses resolve through the closure's vivified
  // `.prototype` object (acorn's `Parser.prototype.m = fn; new Parser().m()`
  // pattern). Emitted in the ctor PROLOGUE — before the user body compiles —
  // because acorn-style ctors call prototype methods on `this` inside the
  // ctor itself (`this.context = this.initialContext()`); an end-of-ctor
  // registration left those in-ctor dispatches unresolvable. JS-host mode
  // only — standalone/WASI construction stays pure Wasm; the native
  // equivalent rides on the #1888 open-object runtime in a later dogfood lap.
  // Buffer-reach note: the flush below walks ctx.currentFunc (still the
  // OUTER call-site fctx here) plus ctorFctx.body explicitly; once the body
  // compile switches ctx.currentFunc to ctorFctx, later shifts reach these
  // prologue instrs through currentFunc.body, and after attachment through
  // ctx.mod.functions.
  if (!ctx.standalone && !ctx.wasi) {
    const ctorGlobalIdx = ctx.moduleGlobals.get(funcName) ?? ctx.funcClosureGlobals.get(funcName);
    if (ctorGlobalIdx !== undefined) {
      ensureLateImport(ctx, "__register_fnctor_instance", [{ kind: "externref" }, { kind: "externref" }], []);
      // Apply the deferred index shift NOW (same discipline as every other
      // ensureLateImport caller in this file) so the `call` below targets the
      // import's final index instead of being re-shifted onto a neighbour.
      flushLateImportShifts(ctx, ctorFctx);
      const regIdx = ctx.funcMap.get("__register_fnctor_instance");
      if (regIdx !== undefined) {
        ctorFctx.body.push({ op: "local.get", index: selfLocal });
        ctorFctx.body.push({ op: "extern.convert_any" });
        ctorFctx.body.push({ op: "global.get", index: ctorGlobalIdx } as Instr);
        const gdef = ctx.mod.globals[localGlobalIdx(ctx, ctorGlobalIdx)];
        if (gdef && gdef.type.kind !== "externref" && gdef.type.kind !== "ref_extern") {
          ctorFctx.body.push({ op: "extern.convert_any" });
        }
        ctorFctx.body.push({ op: "call", funcIdx: regIdx });
      }
    }
  }

  // Compile the function body
  const savedFunc = ctx.currentFunc;
  if (savedFunc) ctx.parentBodiesStack.push(savedFunc.body);
  if (savedFunc) ctx.funcStack.push(savedFunc);
  ctx.currentFunc = ctorFctx;
  for (const stmt of body.statements) {
    compileStatement(ctx, ctorFctx, stmt);
  }
  if (savedFunc) ctx.funcStack.pop();
  if (savedFunc) ctx.parentBodiesStack.pop();
  ctx.currentFunc = savedFunc;

  // Attach the live body array to the registered function FIRST: the
  // late-import registration below can shift function indices, and the shift
  // walkers reach this body only through ctx.mod.functions (#1712 — same
  // orphan-buffer class as the compileIfStatement then-branch fix).
  ctorFunc.locals = ctorFctx.locals;
  ctorFunc.body = ctorFctx.body;

  // (#1712) The instance → constructor-closure registration
  // (__register_fnctor_instance) is emitted in the ctor PROLOGUE above —
  // before the user body — so in-ctor prototype-method calls on `this`
  // (`this.context = this.initialContext()`) already resolve through the
  // vivified prototype.

  // Return the struct instance
  ctorFctx.body.push({ op: "local.get", index: selfLocal });

  // 5. Emit the call to the constructor at the call site
  const args = expr.arguments ?? [];
  // Use the in-scope ctorParams, NOT getFuncParamTypes(ctx, ctorFuncIdx): the
  // (#1712) __register_fnctor_instance late import above opens a deferred
  // index-shift window (#329/#1899) in which ctorFuncIdx is stale-low against
  // the already-incremented numImportFuncs, so an index-based signature lookup
  // would read the PREVIOUS function's params and coerce arguments against the
  // wrong types (observed: `call[0] expected externref, found (ref null $N)`).
  const paramTypes: ValType[] | undefined = ctorParams;
  for (let i = 0; i < args.length; i++) {
    compileExpression(ctx, fctx, args[i]!, paramTypes?.[i]);
  }
  if (paramTypes) {
    for (let i = args.length; i < paramTypes.length; i++) {
      pushDefaultValue(fctx, paramTypes[i]!, ctx);
    }
  }
  // Re-lookup funcIdx in case addUnionImports shifted indices
  const finalCtorIdx = ctx.funcMap.get(classMemberFuncKey(ctx, ctorName)) ?? ctorFuncIdx; // (#1983)
  maybeSetArgcForKnownCall(ctx, fctx, ctorName, args.length, paramTypes?.length ?? args.length);
  fctx.body.push({ op: "call", funcIdx: finalCtorIdx });
  return { kind: "ref", typeIdx: structTypeIdx };
}

/**
 * Compile `new FunctionExpression(args)` — treats the function expression
 * as an immediately-invoked constructor. The function body is compiled
 * as a lifted closure function and called with the provided arguments.
 * Supports spread arguments and the `arguments` object.
 */
function compileNewFunctionExpression(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.NewExpression,
  funcExpr: ts.FunctionExpression,
): ValType | null {
  const closureId = ctx.closureCounter++;
  const closureName = `__new_ctor_${closureId}`;
  const body = funcExpr.body;
  if (!body || !ts.isBlock(body)) return null;

  // 1. Flatten call-site arguments (resolve spread on array literals)
  const rawArgs = expr.arguments ?? [];
  const flatArgs = flattenCallArgs(rawArgs);
  if (!flatArgs) {
    // Can't flatten spread at compile time — unsupported
    reportError(ctx, expr, "new FunctionExpression with non-literal spread not supported");
    return null;
  }

  const needsArguments = usesArguments(body);

  // 2. Determine the parameter list for the lifted function
  //    Use the function's formal params if it has them, otherwise
  //    create f64 params matching the flattened call-site args.
  const formalParams: ValType[] = [];
  if (funcExpr.parameters.length > 0) {
    for (const p of funcExpr.parameters) {
      const paramType = ctx.checker.getTypeAtLocation(p);
      formalParams.push(resolveWasmType(ctx, paramType));
    }
  } else {
    // No formal params — create f64 params for each call-site arg
    for (let i = 0; i < flatArgs.length; i++) {
      formalParams.push({ kind: "f64" });
    }
  }

  // 3. Analyze captured variables
  const referencedNames = new Set<string>();
  for (const stmt of body.statements) {
    collectReferencedIdentifiers(stmt, referencedNames);
  }
  const writtenInClosure = new Set<string>();
  for (const stmt of body.statements) {
    collectWrittenIdentifiers(stmt, writtenInClosure);
  }

  const captures: {
    name: string;
    type: ValType;
    localIdx: number;
    mutable: boolean;
    alreadyBoxed: boolean;
    valType?: ValType;
  }[] = [];
  for (const name of referencedNames) {
    const localIdx = fctx.localMap.get(name);
    if (localIdx === undefined) continue;
    if (ctx.funcMap.has(name)) continue;
    // #1832 — `isOwnParamName` recognises names bound by a destructuring
    // (object/array binding) parameter, not just identifier params. The old
    // identifier-only check missed `function({a}){ return a }`, so a
    // destructured param name was wrongly treated as a free variable and
    // captured from an outer scope that also declared it.
    if (isOwnParamName(funcExpr, name)) continue;
    if (name === "arguments") continue;
    const type =
      localIdx < fctx.params.length
        ? fctx.params[localIdx]!.type
        : (fctx.locals[localIdx - fctx.params.length]?.type ?? { kind: "f64" });
    const isMutable = writtenInClosure.has(name);
    const alreadyBoxed = !!fctx.boxedCaptures?.has(name);
    const valType = alreadyBoxed ? fctx.boxedCaptures!.get(name)!.valType : undefined;
    captures.push({
      name,
      type,
      localIdx,
      mutable: isMutable,
      alreadyBoxed,
      valType,
    });
  }

  // 4. Build the closure struct type
  const structFields = [
    { name: "func", type: { kind: "funcref" as const }, mutable: false },
    ...captures.map((c) => {
      if (c.mutable) {
        if (c.alreadyBoxed) {
          // Local already holds a ref cell — reuse the existing ref-cell type
          // (the local's type IS the ref cell type). Avoids double-wrapping
          // when the variable was pre-boxed at function entry (#996).
          return { name: c.name, type: c.type, mutable: false };
        }
        const refCellTypeIdx = getOrRegisterRefCellType(ctx, c.type);
        return {
          name: c.name,
          type: { kind: "ref_null" as const, typeIdx: refCellTypeIdx },
          mutable: false,
        };
      }
      return { name: c.name, type: c.type, mutable: false };
    }),
  ];

  const structTypeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: `${closureName}_struct`,
    fields: structFields,
  });

  // 5. Build the lifted function
  //    Params: (ref $closure_struct, arg0: f64, arg1: f64, ...)
  const liftedParams: ValType[] = [{ kind: "ref", typeIdx: structTypeIdx }, ...formalParams];

  const liftedFuncTypeIdx = addFuncType(ctx, liftedParams, [], `${closureName}_type`);

  // Create the lifted function context
  const paramDefs: { name: string; type: ValType }[] = [
    { name: "__self", type: { kind: "ref", typeIdx: structTypeIdx } },
  ];
  if (funcExpr.parameters.length > 0) {
    for (let i = 0; i < funcExpr.parameters.length; i++) {
      const p = funcExpr.parameters[i]!;
      paramDefs.push({
        name: ts.isIdentifier(p.name) ? p.name.text : `__param${i}`,
        type: formalParams[i] ?? { kind: "f64" },
      });
    }
  } else {
    for (let i = 0; i < flatArgs.length; i++) {
      paramDefs.push({ name: `__arg${i}`, type: { kind: "f64" } });
    }
  }

  const liftedFctx: FunctionContext = {
    name: closureName,
    params: paramDefs,
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

  for (let i = 0; i < liftedFctx.params.length; i++) {
    liftedFctx.localMap.set(liftedFctx.params[i]!.name, i);
  }

  // Initialize locals for captured variables from struct fields
  for (let i = 0; i < captures.length; i++) {
    const cap = captures[i]!;
    if (cap.mutable) {
      // If the outer scope already had this variable boxed (pre-box from #996
      // or a previous closure that boxed it), the struct field IS the ref cell
      // — extract the existing ref-cell type index and reuse the original
      // value type so the inner code reads/writes through the SAME cell as
      // the outer scope.
      let refCellTypeIdx: number;
      let valType: ValType;
      if (cap.alreadyBoxed && (cap.type.kind === "ref" || cap.type.kind === "ref_null")) {
        refCellTypeIdx = (cap.type as { typeIdx: number }).typeIdx;
        valType = cap.valType ?? { kind: "f64" };
      } else {
        refCellTypeIdx = getOrRegisterRefCellType(ctx, cap.type);
        valType = cap.type;
      }
      const refCellType: ValType = {
        kind: "ref_null",
        typeIdx: refCellTypeIdx,
      };
      const localIdx = allocLocal(liftedFctx, cap.name, refCellType);
      liftedFctx.body.push({ op: "local.get", index: 0 });
      liftedFctx.body.push({
        op: "struct.get",
        typeIdx: structTypeIdx,
        fieldIdx: i + 1,
      });
      liftedFctx.body.push({ op: "local.set", index: localIdx });
      if (!liftedFctx.boxedCaptures) liftedFctx.boxedCaptures = new Map();
      liftedFctx.boxedCaptures.set(cap.name, {
        refCellTypeIdx,
        valType,
      });
    } else {
      // Check if this capture is an already-boxed ref cell from the outer scope
      const outerBoxed = fctx.boxedCaptures?.get(cap.name);
      if (outerBoxed && (cap.type.kind === "ref" || cap.type.kind === "ref_null")) {
        const refCellType: ValType = {
          kind: "ref_null",
          typeIdx: outerBoxed.refCellTypeIdx,
        };
        const localIdx = allocLocal(liftedFctx, cap.name, refCellType);
        liftedFctx.body.push({ op: "local.get", index: 0 });
        liftedFctx.body.push({
          op: "struct.get",
          typeIdx: structTypeIdx,
          fieldIdx: i + 1,
        });
        liftedFctx.body.push({ op: "local.set", index: localIdx });
        if (!liftedFctx.boxedCaptures) liftedFctx.boxedCaptures = new Map();
        liftedFctx.boxedCaptures.set(cap.name, {
          refCellTypeIdx: outerBoxed.refCellTypeIdx,
          valType: outerBoxed.valType,
        });
      } else {
        const localIdx = allocLocal(liftedFctx, cap.name, cap.type);
        liftedFctx.body.push({ op: "local.get", index: 0 });
        liftedFctx.body.push({
          op: "struct.get",
          typeIdx: structTypeIdx,
          fieldIdx: i + 1,
        });
        liftedFctx.body.push({ op: "local.set", index: localIdx });
      }
    }
  }

  // Set up `arguments` if the body references it
  if (needsArguments) {
    // Ensure __box_number is available for boxing numeric params
    const hasNumericFormal = formalParams.some((pt) => pt.kind === "f64" || pt.kind === "i32");
    if (hasNumericFormal) {
      ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
      flushLateImportShifts(ctx, fctx);
    }

    const numArgs = formalParams.length;
    const elemType: ValType = { kind: "externref" };
    const vti = getOrRegisterVecType(ctx, "externref", elemType);
    const ati = getArrTypeIdxFromVec(ctx, vti);
    const vecRef: ValType = { kind: "ref", typeIdx: vti };
    const argsLocal = allocLocal(liftedFctx, "arguments", vecRef);
    const arrTmp = allocLocal(liftedFctx, "__args_arr_tmp", {
      kind: "ref",
      typeIdx: ati,
    });

    // Ensure __unbox_number is available for reverse sync
    if (hasNumericFormal) {
      ensureLateImport(ctx, "__unbox_number", [{ kind: "externref" }], [{ kind: "f64" }]);
      flushLateImportShifts(ctx, liftedFctx);
    }

    // Set up mapped arguments info (#849) — params start at index 1 (skip __self)
    liftedFctx.mappedArgsInfo = {
      argsLocalIdx: argsLocal,
      arrTypeIdx: ati,
      vecTypeIdx: vti,
      paramCount: numArgs,
      paramOffset: 1, // skip __self capture param
      paramTypes: formalParams.slice(),
    };

    // Push each param coerced to externref
    for (let i = 0; i < numArgs; i++) {
      liftedFctx.body.push({ op: "local.get", index: i + 1 }); // skip __self
      const pt = formalParams[i]!;
      if (pt.kind === "f64") {
        const boxIdx = ctx.funcMap.get("__box_number");
        if (boxIdx !== undefined) {
          liftedFctx.body.push({ op: "call", funcIdx: boxIdx });
        } else {
          liftedFctx.body.push({ op: "drop" });
          liftedFctx.body.push({ op: "ref.null.extern" });
        }
      } else if (pt.kind === "i32") {
        liftedFctx.body.push({ op: "f64.convert_i32_s" });
        const boxIdx = ctx.funcMap.get("__box_number");
        if (boxIdx !== undefined) {
          liftedFctx.body.push({ op: "call", funcIdx: boxIdx });
        } else {
          liftedFctx.body.push({ op: "drop" });
          liftedFctx.body.push({ op: "ref.null.extern" });
        }
      } else if (pt.kind === "ref" || pt.kind === "ref_null") {
        liftedFctx.body.push({ op: "extern.convert_any" });
      }
      // externref params are already externref — no conversion needed
    }
    liftedFctx.body.push({
      op: "array.new_fixed",
      typeIdx: ati,
      length: numArgs,
    });
    liftedFctx.body.push({ op: "local.set", index: arrTmp });
    liftedFctx.body.push({ op: "i32.const", value: numArgs });
    liftedFctx.body.push({ op: "local.get", index: arrTmp });
    liftedFctx.body.push({ op: "struct.new", typeIdx: vti });
    liftedFctx.body.push({ op: "local.set", index: argsLocal });
  }

  // 6. Compile the function body
  const savedFunc = ctx.currentFunc;
  if (savedFunc) ctx.parentBodiesStack.push(savedFunc.body);
  if (savedFunc) ctx.funcStack.push(savedFunc);
  ctx.currentFunc = liftedFctx;
  for (const stmt of body.statements) {
    compileStatement(ctx, liftedFctx, stmt);
  }
  if (savedFunc) ctx.funcStack.pop();
  if (savedFunc) ctx.parentBodiesStack.pop();
  ctx.currentFunc = savedFunc;

  // 7. Register the lifted function
  const liftedFuncIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.mod.functions.push({
    name: closureName,
    typeIdx: liftedFuncTypeIdx,
    locals: liftedFctx.locals,
    body: liftedFctx.body,
    exported: false,
  });
  ctx.funcMap.set(closureName, liftedFuncIdx);

  // 8. At the call site: build closure struct, push args, call
  fctx.body.push({ op: "ref.func", funcIdx: liftedFuncIdx });
  for (const cap of captures) {
    if (cap.mutable) {
      if (fctx.boxedCaptures?.has(cap.name)) {
        fctx.body.push({ op: "local.get", index: cap.localIdx });
      } else {
        const refCellTypeIdx = getOrRegisterRefCellType(ctx, cap.type);
        fctx.body.push({ op: "local.get", index: cap.localIdx });
        fctx.body.push({ op: "struct.new", typeIdx: refCellTypeIdx });
        const boxedLocalIdx = allocLocal(fctx, `__boxed_${cap.name}`, {
          kind: "ref_null",
          typeIdx: refCellTypeIdx,
        });
        fctx.body.push({ op: "local.tee", index: boxedLocalIdx });
        fctx.localMap.set(cap.name, boxedLocalIdx);
        if (!fctx.boxedCaptures) fctx.boxedCaptures = new Map();
        fctx.boxedCaptures.set(cap.name, { refCellTypeIdx, valType: cap.type });
      }
    } else {
      fctx.body.push({ op: "local.get", index: cap.localIdx });
    }
  }
  fctx.body.push({ op: "struct.new", typeIdx: structTypeIdx });

  // Store closure struct in local for __self arg
  const closureLocal = allocLocal(fctx, `__ctor_closure_${closureId}`, {
    kind: "ref",
    typeIdx: structTypeIdx,
  });
  fctx.body.push({ op: "local.set", index: closureLocal });

  // Push __self argument
  fctx.body.push({ op: "local.get", index: closureLocal });

  // Push call-site arguments (flattened, spread already resolved)
  for (let i = 0; i < flatArgs.length; i++) {
    compileExpression(ctx, fctx, flatArgs[i]!, formalParams[i]);
  }

  // Call the lifted function. Re-resolve its index from funcMap: compiling the
  // arguments above may have added late imports (e.g. an object-spread arg like
  // `{...null}` pulls in `__new_plain_object`/`__object_assign`), which shifts
  // every defined-function index up. The shift machinery patches funcMap and the
  // already-emitted `ref.func` instruction, but the `liftedFuncIdx` captured at
  // registration time is stale — using it here would make `call` and `ref.func`
  // disagree, emitting an invalid module (#1602).
  const resolvedLiftedIdx = ctx.funcMap.get(closureName) ?? liftedFuncIdx;
  fctx.body.push({ op: "call", funcIdx: resolvedLiftedIdx });

  // new expression returns the constructed object — produce externref null
  // since we don't construct actual objects, and callers typically discard the result
  fctx.body.push({ op: "ref.null.extern" });
  return { kind: "externref" };
}

/**
 * Compile a ClassExpression used as a value (e.g. `x = class { ... }`).
 * The class should already be collected during the collection phase.
 * We produce the constructor function reference so the class can be instantiated.
 */
/**
 * §15.7.1 ClassDefinitionEvaluation: a named class binds its own name in an
 * inner scope that is populated only AFTER the `extends` clause is evaluated.
 * Referencing that name inside `extends` hits the TDZ — `(class x extends x {})`
 * must throw ReferenceError (#1594B). The inner binding shadows any outer `x`,
 * so any reference to the class's own name in `extends` is the TDZ binding.
 */
function classExtendsReferencesOwnName(expr: ts.ClassExpression): boolean {
  if (!expr.name) return false;
  const ownName = expr.name.text;
  if (!expr.heritageClauses) return false;
  for (const clause of expr.heritageClauses) {
    if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue;
    for (const typeNode of clause.types) {
      let found = false;
      const visit = (node: ts.Node): void => {
        if (found) return;
        if (ts.isIdentifier(node) && node.text === ownName) {
          found = true;
          return;
        }
        ts.forEachChild(node, visit);
      };
      visit(typeNode.expression);
      if (found) return true;
    }
  }
  return false;
}

/**
 * (#1602) Emit a class-expression-as-value: the constructor wrapped in a
 * closure-struct converted to externref. A bare `ref.func` (funcref) is NOT a
 * subtype of anyref/externref, so when the class value flowed into an externref
 * context — `(class {...}).f` member read feeding `__extern_get`, or passed as
 * a call argument — the raw funcref was left on the stack where externref was
 * required, producing an invalid module (`call expected externref, found
 * ref.func`). Mirror the proven `ClassName.constructor` / static-method
 * extraction path: wrap the ctor funcref in a closure struct and
 * `extern.convert_any`. Falls back to the legacy funcref only if closure
 * construction fails (signature unresolvable), preserving prior behaviour.
 */
function emitClassCtorValue(ctx: CodegenContext, fctx: FunctionContext, ctorName: string, funcIdx: number): ValType {
  const closureRef = emitFuncRefAsClosure(ctx, fctx, ctorName, funcIdx);
  if (closureRef) {
    fctx.body.push({ op: "extern.convert_any" });
    return { kind: "externref" };
  }
  fctx.body.push({ op: "ref.func", funcIdx });
  return { kind: "funcref" };
}

function compileClassExpression(ctx: CodegenContext, fctx: FunctionContext, expr: ts.ClassExpression): ValType | null {
  // §15.7.1: the class-expression name is in TDZ during its own `extends`
  // evaluation. `(class x extends x {})` must throw ReferenceError (#1594B).
  if (classExtendsReferencesOwnName(expr)) {
    emitThrowReferenceError(ctx, fctx, `Cannot access '${expr.name!.text}' before initialization`);
    fctx.body.push({ op: "ref.null.extern" });
    return { kind: "externref" };
  }

  // Look up the synthetic name assigned during the collection phase
  const syntheticName = ctx.anonClassExprNames.get(expr);
  const classNameForCheck = syntheticName ?? expr.name?.text;

  // ES2015 14.5.14 step 21: class with static 'prototype' member must throw TypeError
  if (classNameForCheck && ctx.classThrowsOnEval.has(classNameForCheck)) {
    emitThrowTypeError(ctx, fctx, "Classes may not have a static property named 'prototype'");
    fctx.body.push({ op: "unreachable" });
    return { kind: "externref" };
  }

  if (syntheticName) {
    const ctorName = `${syntheticName}_new`;
    const funcIdx = ctx.funcMap.get(classMemberFuncKey(ctx, ctorName)); // (#1983)
    if (funcIdx !== undefined) {
      return emitClassCtorValue(ctx, fctx, ctorName, funcIdx);
    }
  }

  // If the class has a name, check if it was collected under that name
  if (expr.name) {
    const className = expr.name.text;
    if (ctx.classSet.has(className)) {
      const ctorName = `${className}_new`;
      const funcIdx = ctx.funcMap.get(classMemberFuncKey(ctx, ctorName)); // (#1983)
      if (funcIdx !== undefined) {
        return emitClassCtorValue(ctx, fctx, ctorName, funcIdx);
      }
    }
  }

  // Fallback: produce externref null (class was not collected)
  fctx.body.push({ op: "ref.null.extern" });
  return { kind: "externref" };
}

function compileNewExpression(ctx: CodegenContext, fctx: FunctionContext, expr: ts.NewExpression): ValType | null {
  // Handle `new function() { ... }(args)` — constructor with function expression
  if (ts.isFunctionExpression(expr.expression)) {
    return compileNewFunctionExpression(ctx, fctx, expr, expr.expression);
  }

  // (#1528b) Unwrap parens AND `as`/`!`/type-assertion wrappers so the static
  // non-constructor guards below still fire on `new ((() => {}) as any)()` etc.
  // — the bare paren-only unwrap let cast arrows slip through to the dynamic
  // path and silently no-throw. Mirrors the builtin-namespace unwrap below.
  const unwrapNewTarget = (e: ts.Expression): ts.Expression => {
    let cur = e;
    while (
      ts.isParenthesizedExpression(cur) ||
      ts.isAsExpression(cur) ||
      ts.isNonNullExpression(cur) ||
      ts.isTypeAssertionExpression(cur)
    ) {
      cur = ts.isParenthesizedExpression(cur)
        ? cur.expression
        : ts.isAsExpression(cur)
          ? cur.expression
          : ts.isNonNullExpression(cur)
            ? cur.expression
            : (cur as ts.TypeAssertion).expression;
    }
    return cur;
  };

  // TextEncoder/TextDecoder are standard Web/Node classes, but standalone and
  // WASI builds cannot depend on host `env.TextEncoder_*` imports. The instance
  // carries no state for the UTF-8-only surface implemented here, so the native
  // method fast paths use this evaluated placeholder receiver.
  if ((noJsHost(ctx) || ctx.strictNoHostImports) && ctx.nativeStrings && ts.isIdentifier(expr.expression)) {
    const ctorName = expr.expression.text;
    if (ctorName === "TextEncoder" || ctorName === "TextDecoder") {
      const args = expr.arguments ?? [];
      for (const arg of args) {
        const argType = compileExpression(ctx, fctx, arg);
        if (argType !== null) fctx.body.push({ op: "drop" } as Instr);
      }
      fctx.body.push({ op: "ref.null.extern" } as Instr);
      return { kind: "externref" };
    }
  }

  {
    const temporalResult = compileTemporalNewExpression(ctx, fctx, expr);
    if (temporalResult !== undefined) return temporalResult;
  }

  // (#1103a) `new Map()` in standalone / nativeStrings mode → the WasmGC-native
  // Map runtime (map-runtime.ts) instead of a `Map_new` host import. `new Map()`
  // is a NewExpression, so the interception must live here (not in the
  // call-expression compiler). Slice 1: no-arg form only — `new Map(iterable)`
  // needs `__map_new_from_arr` (slice 2) and falls through. Returns `ref $Map`
  // so the binding/receiver is typed (see resolveWasmType Map case + the
  // method/.size dispatch in extern.ts / property-access.ts).
  if (
    ctx.nativeStrings &&
    ts.isIdentifier(expr.expression) &&
    expr.expression.text === "Map" &&
    (expr.arguments?.length ?? 0) === 0
  ) {
    addUnionImports(ctx);
    ensureMapHelpers(ctx);
    const mapNewIdx = ctx.mapHelpers.get("__map_new");
    if (mapNewIdx !== undefined && ctx.mapTypeIdx >= 0) {
      fctx.body.push({ op: "call", funcIdx: mapNewIdx });
      return { kind: "ref", typeIdx: ctx.mapTypeIdx };
    }
  }

  // (#2162) `new Set()` in standalone / nativeStrings mode → the WasmGC-native
  // Set runtime, which reuses the Map backing store (`__map_new` yields the
  // same empty `$Map` a Set wraps). No-arg form only; `new Set(iterable)` needs
  // the iterator drive (follow-up slice) and falls through.
  if (
    ctx.nativeStrings &&
    ts.isIdentifier(expr.expression) &&
    expr.expression.text === "Set" &&
    (expr.arguments?.length ?? 0) === 0
  ) {
    addUnionImports(ctx);
    ensureSetHelpers(ctx);
    const mapNewIdx = ctx.mapHelpers.get("__map_new");
    if (mapNewIdx !== undefined && ctx.mapTypeIdx >= 0) {
      fctx.body.push({ op: "call", funcIdx: mapNewIdx });
      return { kind: "ref", typeIdx: ctx.mapTypeIdx };
    }
  }

  // (#2162) `new WeakMap()` / `new WeakSet()` in standalone / nativeStrings mode
  // → the native weak-collection runtime, which reuses the Map backing store
  // (`__map_new` yields the same empty `$Map`). No-arg form only; the iterable
  // form falls through.
  if (
    ctx.nativeStrings &&
    ts.isIdentifier(expr.expression) &&
    (expr.expression.text === "WeakMap" || expr.expression.text === "WeakSet") &&
    (expr.arguments?.length ?? 0) === 0
  ) {
    addUnionImports(ctx);
    ensureWeakCollectionHelpers(ctx);
    const mapNewIdx = ctx.mapHelpers.get("__map_new");
    if (mapNewIdx !== undefined && ctx.mapTypeIdx >= 0) {
      fctx.body.push({ op: "call", funcIdx: mapNewIdx });
      return { kind: "ref", typeIdx: ctx.mapTypeIdx };
    }
  }

  // Arrow functions are NOT constructors — `new (() => {})` throws TypeError (#730)
  {
    const unwrappedNew = unwrapNewTarget(expr.expression);
    if (ts.isArrowFunction(unwrappedNew)) {
      // #1528: throw a real TypeError instance so `assert.throws(TypeError, …)`
      // catches it (the bare-string throw is only `instanceof Error`/string).
      emitThrowTypeError(ctx, fctx, "is not a constructor");
      fctx.body.push({ op: "ref.null.extern" });
      return { kind: "externref" };
    }
  }

  // Handle `new (class { ... })()` — anonymous class expression in new
  // Unwrap parenthesized expressions to find the class expression
  {
    let unwrappedExpr: ts.Expression = expr.expression;
    while (ts.isParenthesizedExpression(unwrappedExpr)) {
      unwrappedExpr = unwrappedExpr.expression;
    }
    if (ts.isClassExpression(unwrappedExpr)) {
      // Look up the synthetic name assigned during the collection phase
      const syntheticName = ctx.anonClassExprNames.get(unwrappedExpr);
      if (syntheticName) {
        const ctorName = `${syntheticName}_new`;
        const funcIdx = ctx.funcMap.get(classMemberFuncKey(ctx, ctorName)); // (#1983)
        if (funcIdx === undefined) {
          reportError(ctx, expr, `Missing constructor for anonymous class`);
          return null;
        }

        const paramTypes = getFuncParamTypes(ctx, funcIdx);
        const args = expr.arguments ?? [];
        for (let i = 0; i < args.length; i++) {
          compileExpression(ctx, fctx, args[i]!, paramTypes?.[i]);
        }
        if (paramTypes) {
          for (let i = args.length; i < paramTypes.length; i++) {
            pushDefaultValue(fctx, paramTypes[i]!, ctx);
          }
        }

        fctx.body.push({ op: "call", funcIdx });
        const structTypeIdx = ctx.structMap.get(syntheticName)!;
        return { kind: "ref", typeIdx: structTypeIdx };
      }
    }
  }

  // Non-identifier constructor: detect non-constructable functions.
  // (#1528b) Unwrap `as`/`!`/type-assertion/paren wrappers so the guards fire
  // on `new (Array.prototype.map as any)()` etc., not just the bare form.
  const unwrappedNonId = unwrapNewTarget(expr.expression);
  if (!ts.isIdentifier(unwrappedNonId) && !ts.isFunctionExpression(unwrappedNonId)) {
    // Pattern 1: `new X.prototype.Y()` — prototype methods are NEVER constructors.
    // This covers both ES2022 (forEach) and ES2023 (with, toSorted) methods,
    // even when TypeScript lib doesn't know about the method (type resolves to `any`).
    if (ts.isPropertyAccessExpression(unwrappedNonId)) {
      const obj = unwrappedNonId.expression; // e.g. Array.prototype
      if (ts.isPropertyAccessExpression(obj) && obj.name.text === "prototype") {
        // #1528: real TypeError instance so test262 `assert.throws(TypeError, …)`
        // catches it (prototype methods are not constructors per spec §9.2.2).
        emitThrowTypeError(ctx, fctx, "is not a constructor");
        fctx.body.push({ op: "ref.null.extern" });
        return { kind: "externref" };
      }
      // (#1732 S2) `new <NonCtorNamespace>.<method>()` — a method pulled off a
      // non-constructor namespace object (Math/JSON/Reflect/Atomics). Every such
      // method is an ordinary function with no [[Construct]] (§21.3/§25.5/§28.1/
      // §25.4), so `new` must throw TypeError. Pattern 2 below only fires when
      // the TS lib KNOWS the method has call-sigs/no-construct-sigs; methods
      // NEWER than the bundled lib (e.g. `Math.f16round`, `Math.sumPrecise`)
      // resolve to `any`, slip past Pattern 2, and reach the unknown-ctor path
      // which never performs [[Construct]] and so wrongly returns instead of
      // throwing (test262 built-ins/Math/f16round/not-a-constructor.js etc.).
      // Keying on the namespace NAME makes the guard lib-version-independent —
      // it fires for any current or future Math/JSON/Reflect/Atomics method. The
      // receiver-name match is intentionally narrow to those four built-ins
      // (the same discipline as the namespace-identifier guard below).
      if (ts.isIdentifier(obj)) {
        const NS_NON_CONSTRUCTORS = new Set(["Math", "JSON", "Reflect", "Atomics"]);
        if (NS_NON_CONSTRUCTORS.has(obj.text)) {
          emitThrowTypeError(ctx, fctx, "is not a constructor");
          fctx.body.push({ op: "ref.null.extern" });
          return { kind: "externref" };
        }
      }
    }

    // Pattern 2: TypeScript knows the expression has call sigs but no construct sigs.
    // e.g. `new decodeURIComponent()`, `new Math.abs()`, `new Array.from()`.
    // Resolve on the unwrapped target so a cast doesn't widen it to `any`.
    const exprType = ctx.checker.getTypeAtLocation(unwrappedNonId);
    const constructSigs = ctx.checker.getSignaturesOfType(exprType, ts.SignatureKind.Construct);
    const callSigs = ctx.checker.getSignaturesOfType(exprType, ts.SignatureKind.Call);
    if (callSigs.length > 0 && constructSigs.length === 0) {
      // #1528: real TypeError instance — spec requires `Construct(F)` to throw
      // `TypeError("F is not a constructor")` when F has no [[Construct]].
      emitThrowTypeError(ctx, fctx, "is not a constructor");
      fctx.body.push({ op: "ref.null.extern" });
      return { kind: "externref" };
    }
  }

  // (#1519 sub-issue B) Built-in non-constructor namespaces — `Math`, `JSON`,
  // `Reflect`, `Atomics` — have neither call nor construct signatures. Per
  // ECMA-262 §7.2.10 IsConstructor, `new`-on a value lacking `[[Construct]]`
  // must throw TypeError. We detect them by name on the unwrapped expression
  // (so `new Math()`, `new (Math)()`, and `new (Math as any)()` all fire).
  // User-defined identifier shadowing keeps its own value-type with
  // construct signatures, so this fires only for the actual builtin symbols
  // (verified via the type checker's `Math`/`JSON`/`Reflect`/`Atomics`
  // namespace lookups in lib.es*.d.ts).
  {
    let unwrapped: ts.Expression = expr.expression;
    while (
      ts.isParenthesizedExpression(unwrapped) ||
      ts.isAsExpression(unwrapped) ||
      ts.isNonNullExpression(unwrapped) ||
      ts.isTypeAssertionExpression(unwrapped)
    ) {
      unwrapped = ts.isParenthesizedExpression(unwrapped)
        ? unwrapped.expression
        : ts.isAsExpression(unwrapped)
          ? unwrapped.expression
          : ts.isNonNullExpression(unwrapped)
            ? unwrapped.expression
            : (unwrapped as ts.TypeAssertion).expression;
    }
    if (ts.isIdentifier(unwrapped)) {
      const name = unwrapped.text;
      const NAMESPACE_NON_CONSTRUCTORS = new Set(["Math", "JSON", "Reflect", "Atomics"]);
      if (NAMESPACE_NON_CONSTRUCTORS.has(name)) {
        // Use the real-TypeError throw path so `assert.throws(TypeError, …)`
        // in test262 negative cases (S11.2.2_A4_T*) observes a TypeError
        // instance, not a bare string. Falls back to a string throw when
        // `__new_TypeError` isn't registered (standalone mode).
        emitThrowTypeError(ctx, fctx, `${name} is not a constructor`);
        fctx.body.push({ op: "ref.null.extern" });
        return { kind: "externref" };
      }
    }
  }

  // Handle `new Promise(executor)` — delegate to host import
  if (ts.isIdentifier(expr.expression) && expr.expression.text === "Promise") {
    let funcIdx =
      ctx.funcMap.get("Promise_new") ??
      ensureLateImport(ctx, "Promise_new", [{ kind: "externref" }], [{ kind: "externref" }]);
    flushLateImportShifts(ctx, fctx);
    funcIdx = ctx.funcMap.get("Promise_new") ?? funcIdx;
    if (funcIdx !== undefined) {
      const args = expr.arguments ?? [];
      if (args.length >= 1) {
        compileExpression(ctx, fctx, args[0]!, { kind: "externref" });
      } else {
        fctx.body.push({ op: "ref.null.extern" });
      }
      fctx.body.push({ op: "call", funcIdx });
    } else {
      fctx.body.push({ op: "ref.null.extern" });
    }
    return { kind: "externref" };
  }

  // Handle `new Number(x)`, `new String(x)`, `new Boolean(x)` — wrapper constructors
  // Return externref so typeof returns "object" (wrapper semantics).
  // Number/Boolean: box to externref via __box_number. String: already externref.
  if (ts.isIdentifier(expr.expression)) {
    const ctorName = expr.expression.text;
    if (ctorName === "Number" || ctorName === "String" || ctorName === "Boolean") {
      const args = expr.arguments ?? [];

      if (ctorName === "Number") {
        // new Number(x) → create real JS Number wrapper object via __new_Number host import
        // (typeof new Number(0) === "object", not "number")
        if (args.length >= 1) {
          // ToNumber(Symbol) throws TypeError (§7.1.4) — the wrapper ctor runs
          // ToNumber on its argument before boxing. Mirror the `Number(sym)`
          // call-path guard so `new Number(Symbol())` throws too (#1564).
          if (isSymbolType(ctx.checker.getTypeAtLocation(args[0]!))) {
            const t = compileExpression(ctx, fctx, args[0]!);
            if (t !== null) fctx.body.push({ op: "drop" });
            emitThrowTypeError(ctx, fctx, "Cannot convert a Symbol value to a number");
            return { kind: "externref" };
          }
          compileExpression(ctx, fctx, args[0]!, { kind: "f64" });
        } else {
          fctx.body.push({ op: "f64.const", value: 0 });
        }
        const newNumIdx = ensureLateImport(ctx, "__new_Number", [{ kind: "f64" }], [{ kind: "externref" }]);
        flushLateImportShifts(ctx, fctx);
        const finalNumIdx = ctx.funcMap.get("__new_Number") ?? newNumIdx;
        if (finalNumIdx !== undefined) fctx.body.push({ op: "call", funcIdx: finalNumIdx });
        return { kind: "externref" };
      }

      if (ctorName === "String") {
        // new String(x) → create real JS String wrapper object via __new_String host import
        // (typeof new String("") === "object", not "string")
        if (args.length >= 1) {
          compileExpression(ctx, fctx, args[0]!, { kind: "externref" });
        } else {
          const emptyStrResult = compileStringLiteral(ctx, fctx, "");
          if (!emptyStrResult) {
            fctx.body.push({ op: "ref.null.extern" });
          }
        }
        const newStrIdx = ensureLateImport(ctx, "__new_String", [{ kind: "externref" }], [{ kind: "externref" }]);
        flushLateImportShifts(ctx, fctx);
        const finalStrIdx = ctx.funcMap.get("__new_String") ?? newStrIdx;
        if (finalStrIdx !== undefined) fctx.body.push({ op: "call", funcIdx: finalStrIdx });
        return { kind: "externref" };
      }

      if (ctorName === "Boolean") {
        // new Boolean(x) → create real JS Boolean wrapper object via __new_Boolean host import
        // (typeof new Boolean(false) === "object", not "boolean")
        if (args.length >= 1) {
          // ToBoolean never throws on Symbol (a Symbol is truthy), but this path
          // coerces the arg to f64 first, which would silently lose the Symbol.
          // A Symbol arg should produce a truthy wrapper: box 1.0.
          if (isSymbolType(ctx.checker.getTypeAtLocation(args[0]!))) {
            const t = compileExpression(ctx, fctx, args[0]!);
            if (t !== null) fctx.body.push({ op: "drop" });
            fctx.body.push({ op: "f64.const", value: 1 });
          } else {
            compileExpression(ctx, fctx, args[0]!, { kind: "f64" });
          }
        } else {
          fctx.body.push({ op: "f64.const", value: 0 });
        }
        const newBoolIdx = ensureLateImport(ctx, "__new_Boolean", [{ kind: "f64" }], [{ kind: "externref" }]);
        flushLateImportShifts(ctx, fctx);
        const finalBoolIdx = ctx.funcMap.get("__new_Boolean") ?? newBoolIdx;
        if (finalBoolIdx !== undefined) fctx.body.push({ op: "call", funcIdx: finalBoolIdx });
        return { kind: "externref" };
      }
    }
  }

  // Handle `new Error(msg)`, `new TypeError(msg)`, `new RangeError(msg)` — create real Error objects
  // via host import so .name, .message, .stack are correct and instanceof works.
  // Standalone fallback: the thrown value is just the message string (as before).
  if (ts.isIdentifier(expr.expression)) {
    const ctorName = expr.expression.text;
    if (
      ctorName === "Error" ||
      ctorName === "TypeError" ||
      ctorName === "RangeError" ||
      ctorName === "SyntaxError" ||
      ctorName === "URIError" ||
      ctorName === "EvalError" ||
      ctorName === "ReferenceError" ||
      ctorName === "Test262Error"
    ) {
      const args = expr.arguments ?? [];
      if (args.length >= 1) {
        // Compile the message argument to externref
        const resultType = compileExpression(ctx, fctx, args[0]!, {
          kind: "externref",
        });
        if (resultType && resultType.kind !== "externref") {
          coerceType(ctx, fctx, resultType, { kind: "externref" });
        }
      } else {
        // No message — push null externref (undefined message)
        fctx.body.push({ op: "ref.null.extern" });
      }
      // (#1104 Phase 1) In WASI/standalone mode, the JS host is unavailable —
      // use a Wasm-native `__new_<Name>` function that builds a `$Error_struct`
      // instead of a `env.__new_<Name>` host import that would leave the
      // module unsatisfiable at instantiation time. JS-host mode is unchanged.
      const importName = `__new_${ctorName}`;
      // #1473 — standalone mode also has no JS host; build the Error in-module.
      if ((ctx.wasi || ctx.standalone) && isWasiErrorName(ctorName)) {
        emitWasiErrorConstructor(ctx, ctorName, 1);
        const internalFuncIdx = ctx.funcMap.get(importName);
        if (internalFuncIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx: internalFuncIdx });
        }
        return { kind: "externref" };
      }
      // Use host import to create a real Error object with correct .name/.message/.stack
      const funcIdx = ensureLateImport(
        ctx,
        importName,
        [{ kind: "externref" }], // message param
        [{ kind: "externref" }], // returns Error object
      );
      flushLateImportShifts(ctx, fctx);
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
      }
      // If import not available (standalone), value is already on stack as externref message
      return { kind: "externref" };
    }
  }

  // Handle `new AggregateError(errors, message, options?)` (#844)
  // AggregateError takes (iterable, message, options?) — pass errors and message as externref
  if (ts.isIdentifier(expr.expression) && expr.expression.text === "AggregateError") {
    const args = expr.arguments ?? [];
    // Compile errors argument (iterable) as externref
    if (args.length >= 1) {
      const errorsType = compileExpression(ctx, fctx, args[0]!, {
        kind: "externref",
      });
      if (errorsType && errorsType.kind !== "externref") {
        coerceType(ctx, fctx, errorsType, { kind: "externref" });
      }
    } else {
      fctx.body.push({ op: "ref.null.extern" });
    }
    // Compile message argument as externref
    if (args.length >= 2) {
      const msgType = compileExpression(ctx, fctx, args[1]!, {
        kind: "externref",
      });
      if (msgType && msgType.kind !== "externref") {
        coerceType(ctx, fctx, msgType, { kind: "externref" });
      }
    } else {
      fctx.body.push({ op: "ref.null.extern" });
    }
    // Compile options argument as externref (for cause property)
    if (args.length >= 3) {
      const optsType = compileExpression(ctx, fctx, args[2]!, {
        kind: "externref",
      });
      if (optsType && optsType.kind !== "externref") {
        coerceType(ctx, fctx, optsType, { kind: "externref" });
      }
    } else {
      fctx.body.push({ op: "ref.null.extern" });
    }
    const funcIdx = ensureLateImport(
      ctx,
      "__new_AggregateError",
      [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
      [{ kind: "externref" }],
    );
    flushLateImportShifts(ctx, fctx);
    if (funcIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx });
    }
    return { kind: "externref" };
  }

  // Handle `new SuppressedError(error, suppressed, message, options?)` (#1634).
  // Spec §20.5.10.1: all four arguments are externref; `options.cause` is
  // installed via the dedicated `__new_SuppressedError` host import. The generic
  // 3-param extern-class path dropped `options` (no `cause`) and mishandled the
  // message coercion, so route through the dedicated import like AggregateError.
  if (ts.isIdentifier(expr.expression) && expr.expression.text === "SuppressedError") {
    const args = expr.arguments ?? [];
    for (let i = 0; i < 4; i++) {
      if (args.length > i) {
        const t = compileExpression(ctx, fctx, args[i]!, { kind: "externref" });
        if (t && t.kind !== "externref") {
          coerceType(ctx, fctx, t, { kind: "externref" });
        }
      } else {
        fctx.body.push({ op: "ref.null.extern" });
      }
    }
    const funcIdx = ensureLateImport(
      ctx,
      "__new_SuppressedError",
      [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
      [{ kind: "externref" }],
    );
    flushLateImportShifts(ctx, fctx);
    if (funcIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx });
    }
    return { kind: "externref" };
  }

  // Handle `new Object()` — create an empty object (equivalent to `{}`).
  // (#1343) Previously this emitted `ref.null.extern`, but JS spec treats
  // `new Object()` as a real object: `Boolean(new Object()) === true`,
  // `(new Object()).hasOwnProperty(...) === false`, etc. Returning null
  // externref made the receiver fall through every host-import branch
  // expecting a real object, e.g. `Boolean(new Object())` returned `false`
  // because `__to_boolean(null) === 0`.
  //
  // Use `__new_plain_object` host import to produce a fresh empty object
  // with the ordinary `Object.prototype` prototype (#1525). `new Object()`
  // per §20.1.1.1 must inherit `Object.prototype` — using `__object_create(null)`
  // gave it a null prototype, so it had no `toString`/`valueOf` and any
  // ToPrimitive coercion (`==`, arithmetic, `String(...)`) threw
  // "Cannot convert object to primitive value" instead of producing
  // "[object Object]". Falls back to `ref.null.extern` only if the import
  // can't be registered.
  if (ts.isIdentifier(expr.expression) && expr.expression.text === "Object") {
    const createIdx = ensureLateImport(ctx, "__new_plain_object", [], [{ kind: "externref" }]);
    flushLateImportShifts(ctx, fctx);
    if (createIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx: createIdx });
      return { kind: "externref" };
    }
    fctx.body.push({ op: "ref.null.extern" });
    return { kind: "externref" };
  }

  // Handle `new Proxy(target, handler)`.
  //
  // JS-host mode: delegate to the `__proxy_create(target, handler)` host import
  // (the host wraps the target in a real JS Proxy with the given handler).
  //
  // Standalone mode (#1100 Phase 1): there is no host Proxy, so route through the
  // Wasm-native `__proxy_create(target, handler)` emitted by `ensureObjectRuntime`
  // (object-runtime.ts `ensureProxyRuntime`). It reads the get/set/has/apply trap
  // closures off the handler object at runtime, allocates a `$Proxy` (subtype of
  // `$Object`), and the property-runtime front-guards (`__extern_get/set/has`)
  // dispatch reads/writes/has through the traps. Both modes share the same
  // `(target, handler) -> externref` signature, so the call site is uniform.
  if (ts.isIdentifier(expr.expression) && expr.expression.text === "Proxy") {
    if (ctx.standalone) {
      const args = expr.arguments ?? [];
      // Force the object runtime (which registers the native __proxy_create +
      // the trap dispatch helpers + the front-guards) before we look up the idx.
      ensureObjectRuntime(ctx);
      const compileToExternref = (arg: ts.Expression | undefined): void => {
        if (arg === undefined) {
          fctx.body.push({ op: "ref.null.extern" });
          return;
        }
        // An OBJECT-LITERAL handler/target must lower to an OPEN `$Object`
        // (`__new_plain_object` + `__extern_set` per prop) so the runtime
        // `__proxy_create` can read the traps off the handler via `__extern_get`.
        // A closed typed struct (the default for an inline literal) hides its
        // fields from the open-object prop-map walk, so every trap reads null and
        // never fires. `compileObjectLiteralAsExternref` builds the open form —
        // the same shape a `const h: any = {…}` handler takes.
        if (ts.isObjectLiteralExpression(arg)) {
          const r = compileObjectLiteralAsExternref(ctx, fctx, arg);
          if (r === null) {
            // Builder unavailable — push undefined so the body stays valid.
            fctx.body.push({ op: "ref.null.extern" });
          }
          return;
        }
        const r = compileExpression(ctx, fctx, arg, { kind: "externref" });
        if (r && r.kind !== "externref") {
          if (r.kind === "ref" || r.kind === "ref_null") {
            fctx.body.push({ op: "extern.convert_any" });
          } else {
            coerceTypeImpl(ctx, fctx, r, { kind: "externref" });
          }
        } else if (!r) {
          // void result (shouldn't happen for a value arg) — push undefined.
          fctx.body.push({ op: "ref.null.extern" });
        }
      };
      compileToExternref(args[0]);
      compileToExternref(args[1]);
      const proxyCreateIdx = ctx.funcMap.get("__proxy_create");
      if (proxyCreateIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: proxyCreateIdx });
      } else {
        // Runtime not available (should not happen) — drop args, push undefined.
        fctx.body.push({ op: "drop" });
        fctx.body.push({ op: "drop" });
        fctx.body.push({ op: "ref.null.extern" });
      }
      return { kind: "externref" };
    }
    const args = expr.arguments ?? [];
    if (args.length >= 1) {
      // Compile target argument and coerce to externref
      const bodyBefore = fctx.body.length;
      const targetResult = compileExpression(ctx, fctx, args[0]!);
      if (targetResult && targetResult.kind !== "externref") {
        if (targetResult.kind === "ref" || targetResult.kind === "ref_null") {
          fctx.body.push({ op: "extern.convert_any" });
        } else {
          coerceTypeImpl(ctx, fctx, targetResult, { kind: "externref" });
        }
      }

      // Compile handler argument and coerce to externref (or push null if missing)
      if (args.length >= 2) {
        const handlerResult = compileExpression(ctx, fctx, args[1]!);
        if (handlerResult && handlerResult.kind !== "externref") {
          if (handlerResult.kind === "ref" || handlerResult.kind === "ref_null") {
            fctx.body.push({ op: "extern.convert_any" });
          } else {
            coerceTypeImpl(ctx, fctx, handlerResult, { kind: "externref" });
          }
        }
      } else {
        fctx.body.push({ op: "ref.null.extern" });
      }

      // Emit call to __proxy_create(target, handler) -> externref
      const proxyIdx = ensureLateImport(
        ctx,
        "__proxy_create",
        [{ kind: "externref" }, { kind: "externref" }],
        [{ kind: "externref" }],
      );
      flushLateImportShifts(ctx, fctx);
      if (proxyIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: proxyIdx });
      }

      return { kind: "externref" };
    }
    // No arguments — `new Proxy()`. Per §28.2.1.1 the missing target/handler
    // are `undefined`, which are not objects, so construction throws TypeError.
    // Route through __proxy_create(null, null) so the runtime raises it (#2180).
    {
      fctx.body.push({ op: "ref.null.extern" });
      fctx.body.push({ op: "ref.null.extern" });
      const proxyIdx = ensureLateImport(
        ctx,
        "__proxy_create",
        [{ kind: "externref" }, { kind: "externref" }],
        [{ kind: "externref" }],
      );
      flushLateImportShifts(ctx, fctx);
      if (proxyIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: proxyIdx });
      }
    }
    return { kind: "externref" };
  }

  // Handle `new Function(...)` — dynamic code generation is not possible in Wasm.
  // Emit a no-op function that returns undefined (ref.null extern) to prevent
  // compile errors. Tests that rely on dynamic behavior will fail at runtime
  // instead of at compile time, which is more informative.
  if (ts.isIdentifier(expr.expression) && expr.expression.text === "Function") {
    // Compile and discard all arguments (they may have side effects)
    const args = expr.arguments ?? [];
    for (const arg of args) {
      const argResult = compileExpression(ctx, fctx, arg);
      if (argResult) {
        fctx.body.push({ op: "drop" });
      }
    }
    // Return ref.null extern — represents a function that returns undefined
    fctx.body.push({ op: "ref.null.extern" });
    return { kind: "externref" };
  }

  // Handle `new Date()`, `new Date(ms)`, `new Date(y, m, d, ...)` — native Date struct
  if (ts.isIdentifier(expr.expression) && expr.expression.text === "Date") {
    const dateTypeIdx = ensureDateStruct(ctx);
    const args = expr.arguments ?? [];

    if (args.length === 0) {
      // (#1483) Under --target wasi, route `new Date()` (no args) to
      // clock_time_get via the __wasi_date_now helper (registered up front in
      // registerWasiImports).
      if (ctx.wasi && ctx.funcMap.has("__wasi_date_now")) {
        fctx.body.push({
          op: "call",
          funcIdx: ctx.funcMap.get("__wasi_date_now")!,
        } as Instr);
        fctx.body.push({ op: "i64.trunc_sat_f64_s" } as Instr);
        fctx.body.push({ op: "struct.new", typeIdx: dateTypeIdx } as Instr);
        return { kind: "ref", typeIdx: dateTypeIdx };
      }
      // (#2164) Pure standalone has no wall clock — emit the Unix epoch (0)
      // directly instead of leaking the unsatisfiable env::__date_now host
      // import (which made `new Date()` a hard instantiate failure standalone,
      // breaking unrelated Date tests). See the matching Date.now() fallback in
      // expressions/calls.ts.
      if (ctx.standalone === true) {
        fctx.body.push({ op: "i64.const", value: 0n });
        fctx.body.push({ op: "struct.new", typeIdx: dateTypeIdx } as Instr);
        return { kind: "ref", typeIdx: dateTypeIdx };
      }
      const dateNowIdx = ensureLateImport(ctx, "__date_now", [], [{ kind: "f64" }]);
      if (dateNowIdx !== undefined) {
        flushLateImportShifts(ctx, fctx);
        fctx.body.push({ op: "call", funcIdx: dateNowIdx } as Instr);
        fctx.body.push({ op: "i64.trunc_sat_f64_s" } as Instr);
      } else {
        fctx.body.push({ op: "i64.const", value: 0n });
      }
      fctx.body.push({ op: "struct.new", typeIdx: dateTypeIdx } as Instr);
      return { kind: "ref", typeIdx: dateTypeIdx };
    }

    if (args.length === 1) {
      // new Date(ms) — millisecond timestamp.
      //
      // (#1344) Detect NaN input and store a sentinel i64 so subsequent getter
      // calls (getDay, getHours, getTime, …) can return NaN per spec
      // (`new Date(NaN).getTime() → NaN`). Without this, `i64.trunc_sat_f64_s`
      // saturates NaN to 0 and the Date silently behaves like the epoch.
      //
      // (#1343) TimeClip per §21.4.1.31: if !isFinite(ms) or abs(ms) > 8.64e15,
      // return NaN. Both NaN and out-of-range get the sentinel. ±Infinity is
      // out-of-range (abs > 8.64e15), so the single magnitude check covers it.
      compileExpression(ctx, fctx, args[0]!, { kind: "f64" });
      const msLocal = allocTempLocal(fctx, { kind: "f64" });
      fctx.body.push({ op: "local.tee", index: msLocal } as Instr);
      // isInvalid = (ms != ms) || (abs(ms) > 8.64e15)
      // ms != ms is true iff ms is NaN (covers NaN)
      fctx.body.push({ op: "local.get", index: msLocal } as Instr);
      fctx.body.push({ op: "f64.ne" } as Instr);
      fctx.body.push({ op: "local.get", index: msLocal } as Instr);
      fctx.body.push({ op: "f64.abs" } as Instr);
      fctx.body.push({ op: "f64.const", value: 8.64e15 } as Instr);
      fctx.body.push({ op: "f64.gt" } as Instr);
      fctx.body.push({ op: "i32.or" } as Instr);
      fctx.body.push({
        op: "if",
        blockType: { kind: "val", type: { kind: "i64" } },
        then: [{ op: "i64.const", value: -9223372036854775808n }],
        else: [{ op: "local.get", index: msLocal } as Instr, { op: "i64.trunc_sat_f64_s" } as Instr],
      });
      releaseTempLocal(fctx, msLocal);
      fctx.body.push({ op: "struct.new", typeIdx: dateTypeIdx } as Instr);
      return { kind: "ref", typeIdx: dateTypeIdx };
    }

    // new Date(year, month, day?, hours?, minutes?, seconds?, ms?)
    // JS months are 0-indexed. Day defaults to 1, rest default to 0.
    {
      const daysFromCivilIdx = ensureDateDaysFromCivilHelper(ctx);

      // (#1343) Track whether any arg is NaN or non-finite. If so, the resulting
      // Date is Invalid (§21.4.2.1 MakeDate / TimeClip step on non-finite).
      // We OR-accumulate an i32 flag and stash the f64 value before trunc.
      const nonFiniteLocal = allocTempLocal(fctx, { kind: "i32" });
      fctx.body.push({ op: "i32.const", value: 0 } as Instr);
      fctx.body.push({ op: "local.set", index: nonFiniteLocal } as Instr);

      const checkNonFinite = (f64Local: number) => {
        // flag = flag | (v != v) | (abs(v) == +Inf)
        // We treat ±Inf as "non-finite enough" too — abs(v) > 8.64e15 is sufficient.
        fctx.body.push({ op: "local.get", index: nonFiniteLocal } as Instr);
        fctx.body.push({ op: "local.get", index: f64Local } as Instr);
        fctx.body.push({ op: "local.get", index: f64Local } as Instr);
        fctx.body.push({ op: "f64.ne" } as Instr); // NaN check
        fctx.body.push({ op: "i32.or" } as Instr);
        fctx.body.push({ op: "local.get", index: f64Local } as Instr);
        fctx.body.push({ op: "f64.abs" } as Instr);
        fctx.body.push({ op: "f64.const", value: 8.64e15 } as Instr);
        fctx.body.push({ op: "f64.gt" } as Instr);
        fctx.body.push({ op: "i32.or" } as Instr);
        fctx.body.push({ op: "local.set", index: nonFiniteLocal } as Instr);
      };

      // Compile year
      compileExpression(ctx, fctx, args[0]!, { kind: "f64" });
      const yearF64Local = allocTempLocal(fctx, { kind: "f64" });
      fctx.body.push({ op: "local.tee", index: yearF64Local } as Instr);
      checkNonFinite(yearF64Local);
      fctx.body.push({ op: "i64.trunc_sat_f64_s" } as Instr);
      const yearLocal = allocTempLocal(fctx, { kind: "i64" });
      fctx.body.push({ op: "local.set", index: yearLocal } as Instr);
      releaseTempLocal(fctx, yearF64Local);

      // Compile month (0-indexed) + 1 for civil algorithm
      compileExpression(ctx, fctx, args[1]!, { kind: "f64" });
      const monthF64Local = allocTempLocal(fctx, { kind: "f64" });
      fctx.body.push({ op: "local.tee", index: monthF64Local } as Instr);
      checkNonFinite(monthF64Local);
      releaseTempLocal(fctx, monthF64Local);
      fctx.body.push({ op: "i64.trunc_sat_f64_s" } as Instr);
      fctx.body.push({ op: "i64.const", value: 1n } as Instr);
      fctx.body.push({ op: "i64.add" } as Instr);
      const monthLocal = allocTempLocal(fctx, { kind: "i64" });
      fctx.body.push({ op: "local.set", index: monthLocal } as Instr);

      // (#1343) For the remaining optional args, also accumulate the non-finite
      // flag when the arg is present.
      const compileTimePart = (argIdx: number, defaultI64: bigint, localKind: ValType) => {
        if (args.length > argIdx) {
          compileExpression(ctx, fctx, args[argIdx]!, { kind: "f64" });
          const f64L = allocTempLocal(fctx, { kind: "f64" });
          fctx.body.push({ op: "local.tee", index: f64L } as Instr);
          checkNonFinite(f64L);
          releaseTempLocal(fctx, f64L);
          fctx.body.push({ op: "i64.trunc_sat_f64_s" } as Instr);
        } else {
          fctx.body.push({ op: "i64.const", value: defaultI64 } as Instr);
        }
        const local = allocTempLocal(fctx, localKind);
        fctx.body.push({ op: "local.set", index: local } as Instr);
        return local;
      };

      const dayLocal = compileTimePart(2, 1n, { kind: "i64" });
      const hoursLocal = compileTimePart(3, 0n, { kind: "i64" });
      const minutesLocal = compileTimePart(4, 0n, { kind: "i64" });
      const secondsLocal = compileTimePart(5, 0n, { kind: "i64" });
      const msLocal = compileTimePart(6, 0n, { kind: "i64" });

      // Handle year 0-99 mapping to 1900-1999 (JS Date quirk)
      // if (0 <= year <= 99) year += 1900
      fctx.body.push(
        { op: "local.get", index: yearLocal } as Instr,
        { op: "i64.const", value: 0n } as Instr,
        { op: "i64.ge_s" } as Instr,
        { op: "local.get", index: yearLocal } as Instr,
        { op: "i64.const", value: 99n } as Instr,
        { op: "i64.le_s" } as Instr,
        { op: "i32.and" } as Instr,
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: yearLocal } as Instr,
            { op: "i64.const", value: 1900n } as Instr,
            { op: "i64.add" } as Instr,
            { op: "local.set", index: yearLocal } as Instr,
          ],
        },
      );

      // Call days_from_civil(year, month, day) → i64 days
      fctx.body.push(
        { op: "local.get", index: yearLocal } as Instr,
        { op: "local.get", index: monthLocal } as Instr,
        { op: "local.get", index: dayLocal } as Instr,
        { op: "call", funcIdx: daysFromCivilIdx } as Instr,
      );

      // timestamp = days * 86400000 + hours * 3600000 + minutes * 60000 + seconds * 1000 + ms
      fctx.body.push(
        { op: "i64.const", value: 86400000n } as Instr,
        { op: "i64.mul" } as Instr,
        { op: "local.get", index: hoursLocal } as Instr,
        { op: "i64.const", value: 3600000n } as Instr,
        { op: "i64.mul" } as Instr,
        { op: "i64.add" } as Instr,
        { op: "local.get", index: minutesLocal } as Instr,
        { op: "i64.const", value: 60000n } as Instr,
        { op: "i64.mul" } as Instr,
        { op: "i64.add" } as Instr,
        { op: "local.get", index: secondsLocal } as Instr,
        { op: "i64.const", value: 1000n } as Instr,
        { op: "i64.mul" } as Instr,
        { op: "i64.add" } as Instr,
        { op: "local.get", index: msLocal } as Instr,
        { op: "i64.add" } as Instr,
      );

      // (#1343) TimeClip §21.4.1.31: if any arg was NaN/non-finite, or
      // abs(ts) > 8.64e15, the time is invalid. The nonFiniteLocal flag covers
      // the f64 NaN/Inf cases (i64.trunc_sat_f64_s would otherwise saturate them
      // silently); the magnitude check covers in-range f64 values that still
      // produce an out-of-range timestamp.
      const tsResultLocal = allocTempLocal(fctx, { kind: "i64" });
      fctx.body.push({ op: "local.set", index: tsResultLocal } as Instr);
      fctx.body.push(
        { op: "local.get", index: nonFiniteLocal } as Instr,
        { op: "local.get", index: tsResultLocal } as Instr,
        { op: "f64.convert_i64_s" } as Instr,
        { op: "f64.abs" } as Instr,
        { op: "f64.const", value: 8.64e15 } as Instr,
        { op: "f64.gt" } as Instr,
        { op: "i32.or" } as Instr,
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "i64" } },
          then: [{ op: "i64.const", value: -9223372036854775808n } as Instr],
          else: [{ op: "local.get", index: tsResultLocal } as Instr],
        } as unknown as Instr,
      );
      releaseTempLocal(fctx, tsResultLocal);
      releaseTempLocal(fctx, nonFiniteLocal);

      fctx.body.push({ op: "struct.new", typeIdx: dateTypeIdx } as Instr);

      releaseTempLocal(fctx, msLocal);
      releaseTempLocal(fctx, secondsLocal);
      releaseTempLocal(fctx, minutesLocal);
      releaseTempLocal(fctx, hoursLocal);
      releaseTempLocal(fctx, dayLocal);
      releaseTempLocal(fctx, monthLocal);
      releaseTempLocal(fctx, yearLocal);

      return { kind: "ref", typeIdx: dateTypeIdx };
    }
  }

  // Handle `new TypedArray(n)` — TypedArray constructors (Uint8Array, Int32Array, Float64Array, etc.)
  // TypedArrays are fixed-length numeric arrays. Native Uint8Array uses the
  // byte-oriented i8_byte vec; other typed arrays stay on the legacy f64
  // representation for now.
  if (ts.isIdentifier(expr.expression)) {
    const TYPED_ARRAY_NAMES = new Set([
      "Int8Array",
      "Uint8Array",
      "Uint8ClampedArray",
      "Int16Array",
      "Uint16Array",
      "Int32Array",
      "Uint32Array",
      "Float32Array",
      "Float64Array",
    ]);
    if (TYPED_ARRAY_NAMES.has(expr.expression.text)) {
      const isNativeUint8Array = noJsHost(ctx) && expr.expression.text === "Uint8Array";
      const elemWasm: ValType = isNativeUint8Array ? { kind: "i8" } : { kind: "f64" };
      const elemKey = isNativeUint8Array ? "i8_byte" : "f64";
      const vecTypeIdx = getOrRegisterVecType(ctx, elemKey, elemWasm);
      const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
      const args = expr.arguments ?? [];

      if (args.length === 0) {
        // new TypedArray() → empty array, length 0
        fctx.body.push({ op: "i32.const", value: 0 }); // length = 0
        fctx.body.push({ op: "i32.const", value: 0 });
        fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
        fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
        return { kind: "ref_null", typeIdx: vecTypeIdx };
      }

      if (args.length === 1) {
        // Check if argument is a numeric literal or expression (size constructor)
        // vs an array/iterable (copy constructor)
        const argType = ctx.checker.getTypeAtLocation(args[0]!);
        const argSym = argType.getSymbol?.();
        // #1654 — `new Uint8Array(arrayBuffer)` views the buffer's bytes. The
        // ArrayBuffer/DataView is backed by an i32_byte vec; copy the bytes
        // into this TypedArray's backing array. Must precede the
        // size-constructor path (an ArrayBuffer is NOT a numeric length).
        //
        // #1670 — only in no-JS-host mode. The byte-buffer view path emits an
        // unconditional `ref.cast` to the native `i32_byte` vec. In JS-host
        // mode an ArrayBuffer / SharedArrayBuffer is NOT lowered to that vec
        // (e.g. `new SharedArrayBuffer(n)` has no native struct), so the cast
        // traps with `illegal cast` before any spec validation runs — this
        // regressed 28 Atomics negative tests built on
        // `new Int32Array(new SharedArrayBuffer(...))`. Host mode already
        // handles the buffer arg correctly via the runtime, so skip the
        // native view path there.
        const argSymName = argSym?.name;
        if (
          noJsHost(ctx) &&
          (argSymName === "ArrayBuffer" || argSymName === "SharedArrayBuffer" || argSymName === "DataView") &&
          !ts.isNumericLiteral(args[0]!) &&
          emitTypedArrayFromByteBuffer(ctx, fctx, args[0]!, vecTypeIdx, arrTypeIdx)
        ) {
          return { kind: "ref_null", typeIdx: vecTypeIdx };
        }
        const isArrayLike =
          argSym?.name === "Array" ||
          ((argType.flags & ts.TypeFlags.Object) !== 0 &&
            argSym?.name !== undefined &&
            TYPED_ARRAY_NAMES.has(argSym.name));

        if (!isArrayLike || ts.isNumericLiteral(args[0]!)) {
          // new TypedArray(n) → fixed-size array of length n, all zeros
          compileExpression(ctx, fctx, args[0]!, { kind: "f64" });
          fctx.body.push({ op: "i32.trunc_sat_f64_s" });
          const sizeLocal = allocLocal(fctx, `__ta_size_${fctx.locals.length}`, { kind: "i32" });
          fctx.body.push({ op: "local.tee", index: sizeLocal }); // length = n
          fctx.body.push({ op: "local.get", index: sizeLocal });
          fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
          fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
          return { kind: "ref_null", typeIdx: vecTypeIdx };
        }

        // new TypedArray(arrayLike) — copy from source array
        // Compile source, then copy elements
        const srcResult = compileExpression(ctx, fctx, args[0]!);
        if (srcResult && (srcResult.kind === "ref" || srcResult.kind === "ref_null")) {
          const srcTypeIdx = (srcResult as { typeIdx: number }).typeIdx;
          const srcTypeDef = ctx.mod.types[srcTypeIdx];
          // Check if source is a vec struct
          if (
            srcTypeDef?.kind === "struct" &&
            srcTypeDef.fields[0]?.name === "length" &&
            srcTypeDef.fields[1]?.name === "data"
          ) {
            const srcVecLocal = allocLocal(fctx, `__ta_src_${fctx.locals.length}`, srcResult);
            fctx.body.push({ op: "local.set", index: srcVecLocal });
            // Get source length
            fctx.body.push({ op: "local.get", index: srcVecLocal });
            fctx.body.push({
              op: "struct.get",
              typeIdx: srcTypeIdx,
              fieldIdx: 0,
            });
            const lenLocal = allocLocal(fctx, `__ta_len_${fctx.locals.length}`, { kind: "i32" });
            fctx.body.push({ op: "local.tee", index: lenLocal });
            // Create new array of that length
            fctx.body.push({ op: "local.get", index: lenLocal });
            fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
            const dstDataLocal = allocLocal(fctx, `__ta_dst_${fctx.locals.length}`, {
              kind: "ref",
              typeIdx: arrTypeIdx,
            });
            fctx.body.push({ op: "local.set", index: dstDataLocal });

            // If source and dest have the same array type, use array.copy
            const srcArrTypeIdx = getArrTypeIdxFromVec(ctx, srcTypeIdx);
            if (srcArrTypeIdx === arrTypeIdx) {
              fctx.body.push({ op: "local.get", index: dstDataLocal });
              fctx.body.push({ op: "i32.const", value: 0 });
              fctx.body.push({ op: "local.get", index: srcVecLocal });
              fctx.body.push({
                op: "struct.get",
                typeIdx: srcTypeIdx,
                fieldIdx: 1,
              });
              fctx.body.push({ op: "i32.const", value: 0 });
              fctx.body.push({ op: "local.get", index: lenLocal });
              fctx.body.push({
                op: "array.copy",
                dstTypeIdx: arrTypeIdx,
                srcTypeIdx: arrTypeIdx,
              } as Instr);
            } else if (srcArrTypeIdx >= 0) {
              const srcArrDef = ctx.mod.types[srcArrTypeIdx];
              const dstArrDef = ctx.mod.types[arrTypeIdx];
              if (srcArrDef?.kind === "array" && dstArrDef?.kind === "array") {
                const srcDataLocal = allocLocal(fctx, `__ta_src_data_${fctx.locals.length}`, {
                  kind: "ref",
                  typeIdx: srcArrTypeIdx,
                });
                const copyIndexLocal = allocLocal(fctx, `__ta_copy_i_${fctx.locals.length}`, { kind: "i32" });
                fctx.body.push({ op: "local.get", index: srcVecLocal });
                fctx.body.push({ op: "struct.get", typeIdx: srcTypeIdx, fieldIdx: 1 });
                fctx.body.push({ op: "local.set", index: srcDataLocal });
                fctx.body.push({ op: "i32.const", value: 0 });
                fctx.body.push({ op: "local.set", index: copyIndexLocal });

                const srcGetOp =
                  srcArrDef.element.kind === "i8"
                    ? "array.get_u"
                    : srcArrDef.element.kind === "i16"
                      ? "array.get_s"
                      : "array.get";
                const convertInstrs: Instr[] =
                  srcArrDef.element.kind === "f64" && dstArrDef.element.kind !== "f64"
                    ? [{ op: "i32.trunc_sat_f64_s" } as Instr]
                    : srcArrDef.element.kind !== "f64" && dstArrDef.element.kind === "f64"
                      ? [{ op: "f64.convert_i32_u" } as Instr]
                      : [];

                fctx.body.push({
                  op: "block",
                  blockType: { kind: "empty" },
                  body: [
                    {
                      op: "loop",
                      blockType: { kind: "empty" },
                      body: [
                        { op: "local.get", index: copyIndexLocal } as Instr,
                        { op: "local.get", index: lenLocal } as Instr,
                        { op: "i32.ge_u" } as Instr,
                        { op: "br_if", depth: 1 } as Instr,
                        { op: "local.get", index: dstDataLocal } as Instr,
                        { op: "local.get", index: copyIndexLocal } as Instr,
                        { op: "local.get", index: srcDataLocal } as Instr,
                        { op: "local.get", index: copyIndexLocal } as Instr,
                        { op: srcGetOp, typeIdx: srcArrTypeIdx } as Instr,
                        ...convertInstrs,
                        { op: "array.set", typeIdx: arrTypeIdx } as Instr,
                        { op: "local.get", index: copyIndexLocal } as Instr,
                        { op: "i32.const", value: 1 } as Instr,
                        { op: "i32.add" } as Instr,
                        { op: "local.set", index: copyIndexLocal } as Instr,
                        { op: "br", depth: 0 } as Instr,
                      ],
                    } as Instr,
                  ],
                } as Instr);
              }
            }
            // Build result vec struct
            fctx.body.push({ op: "local.get", index: lenLocal });
            fctx.body.push({ op: "local.get", index: dstDataLocal });
            fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
            return { kind: "ref_null", typeIdx: vecTypeIdx };
          }
        }
        // Fallback: treat argument as length
        // (source was already compiled and is on stack — drop it and recompile as f64)
        if (srcResult) fctx.body.push({ op: "drop" });
        compileExpression(ctx, fctx, args[0]!, { kind: "f64" });
        fctx.body.push({ op: "i32.trunc_sat_f64_s" });
        const fallbackSize = allocLocal(fctx, `__ta_fsz_${fctx.locals.length}`, { kind: "i32" });
        fctx.body.push({ op: "local.tee", index: fallbackSize });
        fctx.body.push({ op: "local.get", index: fallbackSize });
        fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
        fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
        return { kind: "ref_null", typeIdx: vecTypeIdx };
      }

      // new TypedArray() with multiple args — shouldn't happen per spec, but handle gracefully
      // Treat like new TypedArray(0)
      fctx.body.push({ op: "i32.const", value: 0 });
      fctx.body.push({ op: "i32.const", value: 0 });
      fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
      fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
      return { kind: "ref_null", typeIdx: vecTypeIdx };
    }
  }

  const type = ctx.checker.getTypeAtLocation(expr);
  const symbol = type.getSymbol();
  let className = symbol?.name;

  // For class expressions (const C = class { ... }), the symbol name may be
  // the internal anonymous name (e.g. "__class"). Look up the mapped name first,
  // then fall back to the identifier used in the new expression.
  if (className && !ctx.classSet.has(className)) {
    const mapped = ctx.classExprNameMap.get(className);
    if (mapped) {
      className = mapped;
    }
  }
  if ((!className || !ctx.classSet.has(className)) && ts.isIdentifier(expr.expression)) {
    const idName = expr.expression.text;
    if (ctx.classSet.has(idName)) {
      className = idName;
    } else {
      // Check classExprNameMap — for `let C: any; C = class { ... }; new C()`,
      // the identifier C maps to the synthetic class name via classExprNameMap.
      const mapped = ctx.classExprNameMap.get(idName);
      if (mapped && ctx.classSet.has(mapped)) {
        className = mapped;
      }
    }
  }

  // #682 — standalone mode supports a reduced native RegExp subset for static
  // literal patterns. Unsupported constructor forms still produce explicit
  // #1474-compatible compile errors instead of JS-host imports.
  if (
    ctx.standalone &&
    (isGlobalRegExpType(type) || (ts.isIdentifier(expr.expression) && isGlobalRegExpIdentifier(ctx, expr.expression)))
  ) {
    return compileStandaloneRegExpConstructor(ctx, fctx, expr.arguments ?? [], expr);
  }

  // #1679 — `new this(...)` inside a static method: the callee is `this`, which
  // the checker resolves to the enclosing constructor (e.g. acorn's `Parser`
  // function-style class). It is not an identifier, so the function-constructor
  // path below is skipped. Route a `this`-callee that resolves to a known
  // function-style constructor (or one we can build from its declaration) to the
  // same `<Class>_new` machinery, keyed by the resolved className.
  if (className && !ctx.classSet.has(className) && expr.expression.kind === ts.SyntaxKind.ThisKeyword) {
    const cachedFnCtor = ctx.funcConstructorMap.get(className);
    if (cachedFnCtor) {
      const ctorFuncIdx = ctx.funcMap.get(cachedFnCtor.ctorFuncName);
      if (ctorFuncIdx !== undefined) {
        const paramTypes = getFuncParamTypes(ctx, ctorFuncIdx);
        const args = expr.arguments ?? [];
        for (let i = 0; i < args.length; i++) {
          compileExpression(ctx, fctx, args[i]!, paramTypes?.[i]);
        }
        if (paramTypes) {
          for (let i = args.length; i < paramTypes.length; i++) {
            pushDefaultValue(fctx, paramTypes[i]!, ctx);
          }
        }
        maybeSetArgcForKnownCall(ctx, fctx, cachedFnCtor.ctorFuncName, args.length, paramTypes?.length ?? args.length);
        fctx.body.push({ op: "call", funcIdx: ctorFuncIdx });
        return { kind: "ref", typeIdx: cachedFnCtor.structTypeIdx };
      }
    } else {
      // Build the constructor from the resolved constructor function's declaration.
      const decls = symbol?.getDeclarations();
      if (decls) {
        for (const decl of decls) {
          if (ts.isFunctionDeclaration(decl) && decl.body) {
            const result = compileNewFunctionDeclaration(ctx, fctx, expr, className, decl);
            if (result) return result;
            break;
          }
          // `var Parser = function Parser(...) {...}` (acorn): the constructor's
          // symbol resolves directly to the FunctionExpression node, or to the
          // VariableDeclaration whose initializer is one.
          if (ts.isFunctionExpression(decl) && decl.body) {
            const result = compileNewFunctionDeclaration(
              ctx,
              fctx,
              expr,
              className,
              decl as unknown as ts.FunctionDeclaration,
            );
            if (result) return result;
            break;
          }
          if (ts.isVariableDeclaration(decl) && decl.initializer) {
            let init: ts.Expression = decl.initializer;
            while (ts.isParenthesizedExpression(init)) init = init.expression;
            if (ts.isFunctionExpression(init) && init.body) {
              const result = compileNewFunctionDeclaration(
                ctx,
                fctx,
                expr,
                className,
                init as unknown as ts.FunctionDeclaration,
              );
              if (result) return result;
              break;
            }
          }
        }
      }
    }
  }

  // Check if the identifier resolves to a function declaration used as constructor
  // (e.g. `function Foo() { this.x = 1; }; new Foo()`)
  if ((!className || !ctx.classSet.has(className)) && ts.isIdentifier(expr.expression)) {
    const fnName = expr.expression.text;
    // Check cache first — if we already built a constructor for this function
    const cachedFnCtor = ctx.funcConstructorMap.get(fnName);
    if (cachedFnCtor) {
      const ctorFuncIdx = ctx.funcMap.get(cachedFnCtor.ctorFuncName);
      if (ctorFuncIdx !== undefined) {
        const paramTypes = getFuncParamTypes(ctx, ctorFuncIdx);
        const args = expr.arguments ?? [];
        for (let i = 0; i < args.length; i++) {
          compileExpression(ctx, fctx, args[i]!, paramTypes?.[i]);
        }
        if (paramTypes) {
          for (let i = args.length; i < paramTypes.length; i++) {
            pushDefaultValue(fctx, paramTypes[i]!, ctx);
          }
        }
        const finalIdx = ctx.funcMap.get(cachedFnCtor.ctorFuncName) ?? ctorFuncIdx;
        maybeSetArgcForKnownCall(ctx, fctx, cachedFnCtor.ctorFuncName, args.length, paramTypes?.length ?? args.length);
        fctx.body.push({ op: "call", funcIdx: finalIdx });
        return { kind: "ref", typeIdx: cachedFnCtor.structTypeIdx };
      }
    }
    // Resolve via type checker to find the function declaration
    if (!cachedFnCtor) {
      const exprSymbol = ctx.checker.getSymbolAtLocation(expr.expression);
      const decls = exprSymbol?.getDeclarations();
      if (decls) {
        for (const decl of decls) {
          if (ts.isFunctionDeclaration(decl) && decl.body) {
            const result = compileNewFunctionDeclaration(ctx, fctx, expr, fnName, decl);
            if (result) return result;
            break;
          }
          // Handle `var Con = function() { this.x = 1; }; new Con()`
          // The declaration is a VariableDeclaration whose initializer is a FunctionExpression
          if (ts.isVariableDeclaration(decl) && decl.initializer) {
            let init: ts.Expression = decl.initializer;
            // Unwrap parenthesized expressions
            while (ts.isParenthesizedExpression(init)) init = init.expression;
            if (ts.isFunctionExpression(init) && init.body) {
              // Synthesize a FunctionDeclaration-like node for compileNewFunctionDeclaration
              const result = compileNewFunctionDeclaration(
                ctx,
                fctx,
                expr,
                fnName,
                init as unknown as ts.FunctionDeclaration,
              );
              if (result) return result;
              break;
            }
          }
        }
      }
    }
  }

  if (!className) {
    // Unknown constructor (e.g. Test262Error) — call an imported constructor
    // registered upfront by collectUnknownConstructorImports.
    const ctorName = ts.isIdentifier(expr.expression) ? expr.expression.text : "__unknown";

    // RangeError validation for built-in constructors (type resolves to any
    // when lib declarations are not loaded, so className is undefined here)
    const args = expr.arguments ?? [];

    // (#1732 S1) `new f(...)` where `f` is a LOCAL holding a builtin-method
    // value — e.g. `var f = String.prototype.indexOf; new f`. The compile-time
    // Pattern 1/2 guards above only fire on the *direct* `new X.prototype.Y()`
    // form; through a local the callee is a bare identifier of type `any`, so
    // no static guard sees it and control reaches here, which never performs
    // [[Construct]] and so wrongly does not throw (test262 String.prototype
    // `S15.5.4.*_A7` not-a-constructor cases, ~14 files in JS-host mode).
    //
    // Per ECMA-262 §7.3.13 Construct → §10.2.2 [[Construct]], `new` on a value
    // with no [[Construct]] must throw TypeError. When the local's declaration
    // initializer is a PROVABLY non-constructable expression — a
    // `<...>.prototype.<method>` member access, or a `.bind()/.call()/.apply()`
    // result — route the runtime value through the host `__construct` helper,
    // which throws a real TypeError when IsConstructor(value) is false. Builtin
    // namespaces / intrinsic ctors (ArrayBuffer, DataView, TypedArrays, Error
    // subclasses, Promise) are handled by the explicit branches that FOLLOW, so
    // this guard is scoped to the proven-non-constructor initializer shapes and
    // never intercepts a real constructor. Standalone parity is S4.
    // Unwrap `as`/paren/non-null wrappers so `new (f as any)()` is recognised
    // the same as the bare `new f` form (both reach here with the value held in
    // a local of type `any`).
    let s1Callee: ts.Expression = expr.expression;
    while (ts.isParenthesizedExpression(s1Callee) || ts.isAsExpression(s1Callee) || ts.isNonNullExpression(s1Callee)) {
      s1Callee = ts.isParenthesizedExpression(s1Callee)
        ? s1Callee.expression
        : ts.isAsExpression(s1Callee)
          ? s1Callee.expression
          : (s1Callee as ts.NonNullExpression).expression;
    }
    if (ts.isIdentifier(s1Callee) && !noJsHost(ctx) && resolvesToNonConstructableValue(ctx, s1Callee)) {
      // Evaluate `f` to an externref value (the held callee).
      const calleeTy = compileExpression(ctx, fctx, s1Callee, { kind: "externref" });
      if (calleeTy && calleeTy.kind !== "externref") {
        coerceType(ctx, fctx, calleeTy, { kind: "externref" });
      } else if (calleeTy === null) {
        fctx.body.push({ op: "ref.null.extern" });
      }
      // argsArray — null externref (the A7 cases never reach construction; the
      // TypeError is thrown by the IsConstructor check before args are used).
      fctx.body.push({ op: "ref.null.extern" });
      const funcIdx = ensureLateImport(
        ctx,
        "__construct",
        [{ kind: "externref" }, { kind: "externref" }],
        [{ kind: "externref" }],
      );
      flushLateImportShifts(ctx, fctx);
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
        return { kind: "externref" };
      }
      // Import unavailable (shouldn't happen in JS-host): drop callee+args and
      // fall through to the existing unknown-ctor path below.
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "drop" });
    }

    // new ArrayBuffer(byteLength) — validate non-negative integer length
    if (ctorName === "ArrayBuffer" && args.length >= 1) {
      compileExpression(ctx, fctx, args[0]!, { kind: "f64" });
      const lenF64 = allocLocal(fctx, `__ab_len_f64_${fctx.locals.length}`, {
        kind: "f64",
      });
      fctx.body.push({ op: "local.set", index: lenF64 });
      // Check: len != floor(len) (non-integer or NaN)
      fctx.body.push({ op: "local.get", index: lenF64 });
      fctx.body.push({ op: "local.get", index: lenF64 });
      fctx.body.push({ op: "f64.floor" });
      fctx.body.push({ op: "f64.ne" });
      // Check: len < 0
      fctx.body.push({ op: "local.get", index: lenF64 });
      fctx.body.push({ op: "f64.const", value: 0 });
      fctx.body.push({ op: "f64.lt" });
      fctx.body.push({ op: "i32.or" });
      {
        const rangeErrMsg = "RangeError: Invalid array buffer length";
        addStringConstantGlobal(ctx, rangeErrMsg);
        const tagIdx = ensureExnTag(ctx);
        fctx.body.push({
          op: "if",
          blockType: { kind: "empty" },
          then: [...stringConstantExternrefInstrs(ctx, rangeErrMsg), { op: "throw", tagIdx } as Instr],
          else: [],
        });
      }
    }

    // new DataView(buffer, byteOffset, byteLength) — validate offset and length.
    // #1515 — apply ToIndex semantics: NaN→0, truncate toward 0, > 2^53-1 → RangeError.
    if (ctorName === "DataView") {
      // Validate byteOffset (2nd arg) if provided
      if (args.length >= 2) {
        compileExpression(ctx, fctx, args[1]!, { kind: "f64" });
        const offsetF64 = allocLocal(fctx, `__dv_offset_f64_${fctx.locals.length}`, { kind: "f64" });
        fctx.body.push({ op: "local.set", index: offsetF64 });
        // NaN → 0
        fctx.body.push({ op: "local.get", index: offsetF64 });
        fctx.body.push({ op: "local.get", index: offsetF64 });
        fctx.body.push({ op: "f64.ne" });
        fctx.body.push({
          op: "if",
          blockType: { kind: "empty" },
          then: [{ op: "f64.const", value: 0 } as Instr, { op: "local.set", index: offsetF64 } as Instr],
          else: [],
        });
        fctx.body.push({ op: "local.get", index: offsetF64 });
        fctx.body.push({ op: "f64.trunc" });
        fctx.body.push({ op: "local.set", index: offsetF64 });
        // Check: offset < 0 OR offset > 2^53-1
        fctx.body.push({ op: "local.get", index: offsetF64 });
        fctx.body.push({ op: "f64.const", value: 0 });
        fctx.body.push({ op: "f64.lt" });
        fctx.body.push({ op: "local.get", index: offsetF64 });
        fctx.body.push({ op: "f64.const", value: 9007199254740991 });
        fctx.body.push({ op: "f64.gt" });
        fctx.body.push({ op: "i32.or" });
        {
          const rangeErrMsg = "RangeError: Start offset is outside the bounds of the buffer";
          addStringConstantGlobal(ctx, rangeErrMsg);
          const tagIdx = ensureExnTag(ctx);
          fctx.body.push({
            op: "if",
            blockType: { kind: "empty" },
            then: [...stringConstantExternrefInstrs(ctx, rangeErrMsg), { op: "throw", tagIdx } as Instr],
            else: [],
          });
        }
      }
      // Validate byteLength (3rd arg) if provided
      if (args.length >= 3) {
        compileExpression(ctx, fctx, args[2]!, { kind: "f64" });
        const lenF64 = allocLocal(fctx, `__dv_len_f64_${fctx.locals.length}`, {
          kind: "f64",
        });
        fctx.body.push({ op: "local.set", index: lenF64 });
        // NaN → 0
        fctx.body.push({ op: "local.get", index: lenF64 });
        fctx.body.push({ op: "local.get", index: lenF64 });
        fctx.body.push({ op: "f64.ne" });
        fctx.body.push({
          op: "if",
          blockType: { kind: "empty" },
          then: [{ op: "f64.const", value: 0 } as Instr, { op: "local.set", index: lenF64 } as Instr],
          else: [],
        });
        fctx.body.push({ op: "local.get", index: lenF64 });
        fctx.body.push({ op: "f64.trunc" });
        fctx.body.push({ op: "local.set", index: lenF64 });
        // Check: len < 0 OR len > 2^53-1
        fctx.body.push({ op: "local.get", index: lenF64 });
        fctx.body.push({ op: "f64.const", value: 0 });
        fctx.body.push({ op: "f64.lt" });
        fctx.body.push({ op: "local.get", index: lenF64 });
        fctx.body.push({ op: "f64.const", value: 9007199254740991 });
        fctx.body.push({ op: "f64.gt" });
        fctx.body.push({ op: "i32.or" });
        {
          const rangeErrMsg = "RangeError: Invalid DataView length";
          addStringConstantGlobal(ctx, rangeErrMsg);
          const tagIdx = ensureExnTag(ctx);
          fctx.body.push({
            op: "if",
            blockType: { kind: "empty" },
            then: [...stringConstantExternrefInstrs(ctx, rangeErrMsg), { op: "throw", tagIdx } as Instr],
            else: [],
          });
        }
      }
    }

    // new Array(n) — validate non-negative integer length < 2^32
    if (ctorName === "Array" && args.length === 1) {
      compileExpression(ctx, fctx, args[0]!, { kind: "f64" });
      const nF64 = allocLocal(fctx, `__arr_n_f64_${fctx.locals.length}`, {
        kind: "f64",
      });
      fctx.body.push({ op: "local.set", index: nF64 });
      // Check: n != floor(n) (non-integer or NaN)
      fctx.body.push({ op: "local.get", index: nF64 });
      fctx.body.push({ op: "local.get", index: nF64 });
      fctx.body.push({ op: "f64.floor" });
      fctx.body.push({ op: "f64.ne" });
      // Check: n < 0
      fctx.body.push({ op: "local.get", index: nF64 });
      fctx.body.push({ op: "f64.const", value: 0 });
      fctx.body.push({ op: "f64.lt" });
      fctx.body.push({ op: "i32.or" });
      // Check: n >= 2^32
      fctx.body.push({ op: "local.get", index: nF64 });
      fctx.body.push({ op: "f64.const", value: 4294967296 });
      fctx.body.push({ op: "f64.ge" });
      fctx.body.push({ op: "i32.or" });
      {
        const rangeErrMsg = "RangeError: Invalid array length";
        addStringConstantGlobal(ctx, rangeErrMsg);
        const tagIdx = ensureExnTag(ctx);
        fctx.body.push({
          op: "if",
          blockType: { kind: "empty" },
          then: [...stringConstantExternrefInstrs(ctx, rangeErrMsg), { op: "throw", tagIdx } as Instr],
          else: [],
        });
      }
    }

    const importName = `__new_${ctorName}`;
    const funcIdx = ctx.funcMap.get(importName);

    if (funcIdx !== undefined) {
      // Compile arguments as externref
      for (const arg of args) {
        const resultType = compileExpression(ctx, fctx, arg, {
          kind: "externref",
        });
        if (resultType && resultType.kind !== "externref") {
          fctx.body.push({ op: "drop" });
          fctx.body.push({ op: "ref.null.extern" });
        }
      }
      // Pad missing arguments with ref.null extern (the import may have
      // more params than this particular call site provides, since the
      // import is registered with the *max* arg count across all sites).
      const importParamTypes = getFuncParamTypes(ctx, funcIdx);
      if (importParamTypes) {
        for (let i = args.length; i < importParamTypes.length; i++) {
          pushDefaultValue(fctx, importParamTypes[i]!, ctx);
        }
      }
      // Re-lookup funcIdx: argument compilation may trigger addUnionImports
      const finalNewIdx = ctx.funcMap.get(importName) ?? funcIdx;
      fctx.body.push({ op: "call", funcIdx: finalNewIdx });
    } else {
      // Fallback: no import registered (shouldn't happen), produce null
      fctx.body.push({ op: "ref.null.extern" });
    }
    return { kind: "externref" };
  }

  // Handle local class constructors
  if (ctx.classSet.has(className)) {
    const ctorName = `${className}_new`;
    const funcIdx = ctx.funcMap.get(classMemberFuncKey(ctx, ctorName)); // (#1983)
    if (funcIdx === undefined) {
      reportError(ctx, expr, `Missing constructor for class: ${className}`);
      return null;
    }

    // Compile constructor arguments with type hints
    const paramTypes = getFuncParamTypes(ctx, funcIdx);
    const args = expr.arguments ?? [];
    const ctorRestInfo = ctx.funcRestParams.get(ctorName);
    let ctorActualArgCount = args.length;

    // (#2023) Save the current new.target class-id before evaluating args, so a
    // nested `new` inside an argument expression — and after this construction
    // returns — sees the correct (outer) target. Restored after the call.
    let ntPrevLocal: number | undefined;
    if (ctx.usesNewTarget && !ctx.classExternrefBackedSet.has(className)) {
      const ntGlobalIdx = ensureNewTargetGlobal(ctx);
      ntPrevLocal = allocTempLocal(fctx, { kind: "i32" });
      fctx.body.push({ op: "global.get", index: ntGlobalIdx } as Instr);
      fctx.body.push({ op: "local.set", index: ntPrevLocal });
    }

    // Check for spread arguments
    const hasSpreadCtorArg = args.some((a) => ts.isSpreadElement(a));
    if (hasSpreadCtorArg && paramTypes) {
      // Flatten spread arguments for constructor call
      const flatCtorArgs = flattenCallArgs(args);
      if (flatCtorArgs) {
        ctorActualArgCount = flatCtorArgs.length;
        for (let i = 0; i < flatCtorArgs.length && i < paramTypes.length; i++) {
          compileCtorArgument(ctx, fctx, flatCtorArgs[i]!, paramTypes[i]);
        }
        for (let i = paramTypes.length; i < flatCtorArgs.length; i++) {
          evaluateCtorExtraArgument(ctx, fctx, flatCtorArgs[i]!);
        }
        // Pad missing args
        for (let i = flatCtorArgs.length; i < paramTypes.length; i++) {
          pushDefaultValue(fctx, paramTypes[i]!, ctx);
        }
      } else {
        // Non-literal spread — compile via compileSpreadCallArgs
        compileSpreadCallArgs(ctx, fctx, expr as unknown as ts.CallExpression, funcIdx, ctorRestInfo);
      }
    } else if (ctorRestInfo && !hasSpreadCtorArg) {
      // Calling a rest-param constructor: pack trailing args into a GC array
      for (let i = 0; i < ctorRestInfo.restIndex; i++) {
        if (i < args.length) {
          compileCtorArgument(ctx, fctx, args[i]!, paramTypes?.[i]);
        } else {
          pushDefaultValue(fctx, paramTypes?.[i] ?? { kind: "f64" }, ctx);
        }
      }
      // Pack remaining arguments into a vec struct (array + length)
      const restArgCount = Math.max(0, args.length - ctorRestInfo.restIndex);
      fctx.body.push({ op: "i32.const", value: restArgCount });
      for (let i = ctorRestInfo.restIndex; i < args.length; i++) {
        compileCtorArgument(ctx, fctx, args[i]!, ctorRestInfo.elemType);
      }
      fctx.body.push({
        op: "array.new_fixed",
        typeIdx: ctorRestInfo.arrayTypeIdx,
        length: restArgCount,
      });
      fctx.body.push({ op: "struct.new", typeIdx: ctorRestInfo.vecTypeIdx });
    } else {
      const positionalParamCount = paramTypes?.length ?? args.length;
      for (let i = 0; i < args.length && i < positionalParamCount; i++) {
        compileCtorArgument(ctx, fctx, args[i]!, paramTypes?.[i]);
      }
      for (let i = positionalParamCount; i < args.length; i++) {
        evaluateCtorExtraArgument(ctx, fctx, args[i]!);
      }
      // Pad missing constructor arguments with defaults (arity mismatch)
      if (paramTypes) {
        for (let i = args.length; i < paramTypes.length; i++) {
          pushDefaultValue(fctx, paramTypes[i]!, ctx);
        }
      }
    }

    // (#2023) With args on the stack, set new.target to THIS class's id right
    // before the call. The ctor body (and the super() chain it drives, which
    // calls `_init` and never touches the global) reads this id.
    if (ntPrevLocal !== undefined) {
      emitSetNewTargetBeforeCall(ctx, fctx.body, className);
    }
    // Re-lookup funcIdx: argument compilation may trigger addUnionImports
    // which shifts defined-function indices, making the earlier lookup stale.
    const finalCtorIdx = ctx.funcMap.get(classMemberFuncKey(ctx, ctorName)) ?? funcIdx; // (#1983)
    maybeSetArgcForKnownCall(ctx, fctx, ctorName, ctorActualArgCount, paramTypes?.length ?? ctorActualArgCount);
    fctx.body.push({ op: "call", funcIdx: finalCtorIdx });
    // (#1366a) Externref-backed subclass instances (extends Error / TypeError
    // / ...) bubble up as externref, NOT as (ref $struct).
    if (ctx.classExternrefBackedSet.has(className)) {
      return { kind: "externref" };
    }
    const structTypeIdx = ctx.structMap.get(className)!;
    // (#2023) Restore the saved new.target id, preserving the instance on the
    // stack across the global write.
    if (ntPrevLocal !== undefined) {
      const ntGlobalIdx = ensureNewTargetGlobal(ctx);
      const resultLocal = allocTempLocal(fctx, { kind: "ref", typeIdx: structTypeIdx });
      fctx.body.push({ op: "local.set", index: resultLocal });
      fctx.body.push({ op: "local.get", index: ntPrevLocal });
      fctx.body.push({ op: "global.set", index: ntGlobalIdx } as Instr);
      fctx.body.push({ op: "local.get", index: resultLocal });
      releaseTempLocal(fctx, resultLocal);
      releaseTempLocal(fctx, ntPrevLocal);
    }
    return { kind: "ref", typeIdx: structTypeIdx };
  }

  const externInfo = ctx.externClasses.get(className);
  if (externInfo) {
    // Compile constructor arguments with type hints
    const args = expr.arguments ?? [];
    for (let i = 0; i < args.length; i++) {
      compileExpression(ctx, fctx, args[i]!, externInfo.constructorParams[i]);
    }
    // Pad missing optional args with default values
    for (let i = args.length; i < externInfo.constructorParams.length; i++) {
      pushDefaultValue(fctx, externInfo.constructorParams[i]!, ctx);
    }

    const importName = `${externInfo.importPrefix}_new`;
    const funcIdx = ctx.funcMap.get(importName);
    if (funcIdx === undefined) {
      reportError(ctx, expr, `Missing import for constructor: ${importName}`);
      return null;
    }
    fctx.body.push({ op: "call", funcIdx });
    return { kind: "externref" };
  }

  // new Uint8Array(n), new Int32Array(n), new Float64Array(n), etc. → vec struct.
  // Native Uint8Array uses i8_byte storage; the remaining typed arrays keep
  // the legacy f64 element representation.
  {
    const TYPED_ARRAY_CTORS = new Set([
      "Int8Array",
      "Uint8Array",
      "Int16Array",
      "Uint16Array",
      "Int32Array",
      "Uint32Array",
      "Float32Array",
      "Float64Array",
    ]);
    if (className && TYPED_ARRAY_CTORS.has(className)) {
      const isNativeUint8Array = noJsHost(ctx) && className === "Uint8Array";
      const elemType: ValType = isNativeUint8Array ? { kind: "i8" } : { kind: "f64" };
      const elemKey = isNativeUint8Array ? "i8_byte" : "f64";
      const vecTypeIdx = getOrRegisterVecType(ctx, elemKey, elemType);
      const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
      const args = expr.arguments ?? [];

      if (args.length === 0) {
        // new Uint8Array() → empty array
        fctx.body.push({ op: "i32.const", value: 0 });
        fctx.body.push({ op: "i32.const", value: 0 });
        fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
        fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
      } else {
        // #1654 — `new Uint8Array(arrayBuffer)` must VIEW the buffer's bytes,
        // not treat the buffer as a numeric length. The ArrayBuffer is backed
        // by an `i32_byte` vec (one i32 per byte). Detect that case and copy the
        // bytes into this TypedArray's backing vec.
        const argTsType = ctx.checker.getTypeAtLocation(args[0]!);
        const argSymName = argTsType.getSymbol?.()?.name;
        // #1670 — gate on no-JS-host (see the matching guard above): the
        // native byte-buffer view emits an unconditional `ref.cast` to the
        // `i32_byte` vec that traps in JS-host mode, where the buffer is not
        // that struct.
        const isBufferArg =
          noJsHost(ctx) &&
          (argSymName === "ArrayBuffer" || argSymName === "SharedArrayBuffer" || argSymName === "DataView");
        if (isBufferArg && emitTypedArrayFromByteBuffer(ctx, fctx, args[0]!, vecTypeIdx, arrTypeIdx)) {
          return { kind: "ref_null", typeIdx: vecTypeIdx };
        }
        // new Uint8Array(n) → array of size n, all zeros
        compileExpression(ctx, fctx, args[0]!, { kind: "f64" });
        fctx.body.push({ op: "i32.trunc_sat_f64_s" });
        const sizeLocal = allocLocal(fctx, `__ta_size_${fctx.locals.length}`, {
          kind: "i32",
        });
        fctx.body.push({ op: "local.tee", index: sizeLocal });
        fctx.body.push({ op: "local.get", index: sizeLocal });
        fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
        fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
      }
      return { kind: "ref_null", typeIdx: vecTypeIdx };
    }
  }

  // new ArrayBuffer(byteLength) → vec struct with i32 elements (1 byte per element)
  if (className === "ArrayBuffer") {
    const elemType: ValType = { kind: "i32" };
    const vecTypeIdx = getOrRegisterVecType(ctx, "i32_byte", elemType);
    const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
    const args = expr.arguments ?? [];

    if (args.length >= 1) {
      // new ArrayBuffer(byteLength) → create vec with byteLength elements, all 0
      compileExpression(ctx, fctx, args[0]!, { kind: "f64" });

      // RangeError validation: byteLength must be a non-negative integer < 2^31
      // (We use i32 internally so cap at i32 max)
      const lenF64Local = allocLocal(fctx, `__ab_len_f64_${fctx.locals.length}`, { kind: "f64" });
      fctx.body.push({ op: "local.tee", index: lenF64Local });
      // Check len != floor(len) (non-integer or NaN)
      fctx.body.push({ op: "local.get", index: lenF64Local });
      fctx.body.push({ op: "f64.floor" });
      fctx.body.push({ op: "f64.ne" });
      // Check len < 0
      fctx.body.push({ op: "local.get", index: lenF64Local });
      fctx.body.push({ op: "f64.const", value: 0 });
      fctx.body.push({ op: "f64.lt" });
      fctx.body.push({ op: "i32.or" });
      {
        const rangeErrMsg = "RangeError: Invalid array buffer length";
        addStringConstantGlobal(ctx, rangeErrMsg);
        const tagIdx = ensureExnTag(ctx);
        fctx.body.push({
          op: "if",
          blockType: { kind: "empty" },
          then: [...stringConstantExternrefInstrs(ctx, rangeErrMsg), { op: "throw", tagIdx } as Instr],
          else: [],
        });
      }

      fctx.body.push({ op: "local.get", index: lenF64Local });
      fctx.body.push({ op: "i32.trunc_sat_f64_s" });
    } else {
      fctx.body.push({ op: "i32.const", value: 0 });
    }

    const sizeLocal = allocLocal(fctx, `__ab_size_${fctx.locals.length}`, {
      kind: "i32",
    });
    fctx.body.push({ op: "local.tee", index: sizeLocal });
    fctx.body.push({ op: "local.get", index: sizeLocal });
    fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
    fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
    return { kind: "ref_null", typeIdx: vecTypeIdx };
  }

  // new DataView(buffer) / new DataView(buffer, byteOffset) / new DataView(buffer, byteOffset, byteLength)
  if (className === "DataView") {
    const elemType: ValType = { kind: "i32" };
    const vecTypeIdx = getOrRegisterVecType(ctx, "i32_byte", elemType);
    const args = expr.arguments ?? [];

    if (args.length >= 1) {
      // Compile buffer arg first
      const resultType = compileExpression(ctx, fctx, args[0]!);
      const isStructBuf = resultType !== null && (resultType.kind === "ref" || resultType.kind === "ref_null");

      // Always stash the buffer in a local so we can validate, register the
      // view window via __dv_register_view (#1064), and restore it on stack.
      const bufLocalType: ValType = isStructBuf ? resultType! : { kind: "externref" };
      const bufLocal = allocLocal(fctx, `__dv_buf_${fctx.locals.length}`, bufLocalType);
      fctx.body.push({ op: "local.set", index: bufLocal });

      // Offset and length f64 locals (used for validation AND view-metadata
      // registration). Defaults: offset=0, length=bufferByteLength-offset.
      const offsetF64 = allocLocal(fctx, `__dv_offset_f64_${fctx.locals.length}`, { kind: "f64" });
      const lenF64 = allocLocal(fctx, `__dv_len_f64_${fctx.locals.length}`, {
        kind: "f64",
      });

      if (args.length >= 2) {
        // #1515 ToIndex(byteOffset) per ECMA §7.1.22:
        //   1. If undefined → 0
        //   2. integer = ToIntegerOrInfinity(ToNumber(value))   (NaN → 0; truncate toward 0)
        //   3. If integer < 0 or integer > 2^53-1 → RangeError
        // Previous code threw for any non-integer (1.5 → RangeError) and treated NaN
        // as invalid; spec wants 1.5 → 1 and NaN → 0. Both incorrect behaviors
        // failed `toindex-byteoffset.js` test262 cases.
        compileExpression(ctx, fctx, args[1]!, { kind: "f64" });
        fctx.body.push({ op: "local.set", index: offsetF64 });
        // If NaN, replace with 0 (NaN != NaN is the only condition where v != v).
        fctx.body.push({ op: "local.get", index: offsetF64 });
        fctx.body.push({ op: "local.get", index: offsetF64 });
        fctx.body.push({ op: "f64.ne" });
        fctx.body.push({
          op: "if",
          blockType: { kind: "empty" },
          then: [{ op: "f64.const", value: 0 } as Instr, { op: "local.set", index: offsetF64 } as Instr],
          else: [],
        });
        // Truncate toward zero (ToIntegerOrInfinity for finite non-NaN).
        fctx.body.push({ op: "local.get", index: offsetF64 });
        fctx.body.push({ op: "f64.trunc" });
        fctx.body.push({ op: "local.set", index: offsetF64 });

        // Check: offset < 0 OR offset > 2^53-1 (ToIndex bounds → RangeError)
        fctx.body.push({ op: "local.get", index: offsetF64 });
        fctx.body.push({ op: "f64.const", value: 0 });
        fctx.body.push({ op: "f64.lt" });
        fctx.body.push({ op: "local.get", index: offsetF64 });
        fctx.body.push({ op: "f64.const", value: 9007199254740991 }); // 2^53 - 1
        fctx.body.push({ op: "f64.gt" });
        fctx.body.push({ op: "i32.or" });

        // If buffer is a vec struct, also check offset > bufferByteLength
        if (isStructBuf) {
          fctx.body.push({ op: "local.get", index: offsetF64 });
          fctx.body.push({ op: "local.get", index: bufLocal });
          fctx.body.push({
            op: "struct.get",
            typeIdx: vecTypeIdx,
            fieldIdx: 0,
          }); // buffer length
          fctx.body.push({ op: "f64.convert_i32_s" });
          fctx.body.push({ op: "f64.gt" });
          fctx.body.push({ op: "i32.or" });
        }

        {
          const rangeErrMsg = "RangeError: Start offset is outside the bounds of the buffer";
          addStringConstantGlobal(ctx, rangeErrMsg);
          const tagIdx = ensureExnTag(ctx);
          fctx.body.push({
            op: "if",
            blockType: { kind: "empty" },
            then: [...stringConstantExternrefInstrs(ctx, rangeErrMsg), { op: "throw", tagIdx } as Instr],
            else: [],
          });
        }
      } else {
        // No explicit byteOffset — default to 0
        fctx.body.push({ op: "f64.const", value: 0 });
        fctx.body.push({ op: "local.set", index: offsetF64 });
      }

      if (args.length >= 3) {
        // #1515 ToIndex(byteLength) — same ToIndex semantics as byteOffset above.
        compileExpression(ctx, fctx, args[2]!, { kind: "f64" });
        fctx.body.push({ op: "local.set", index: lenF64 });
        // NaN → 0
        fctx.body.push({ op: "local.get", index: lenF64 });
        fctx.body.push({ op: "local.get", index: lenF64 });
        fctx.body.push({ op: "f64.ne" });
        fctx.body.push({
          op: "if",
          blockType: { kind: "empty" },
          then: [{ op: "f64.const", value: 0 } as Instr, { op: "local.set", index: lenF64 } as Instr],
          else: [],
        });
        // Truncate toward zero
        fctx.body.push({ op: "local.get", index: lenF64 });
        fctx.body.push({ op: "f64.trunc" });
        fctx.body.push({ op: "local.set", index: lenF64 });

        // Check: len < 0 OR len > 2^53-1 → RangeError
        fctx.body.push({ op: "local.get", index: lenF64 });
        fctx.body.push({ op: "f64.const", value: 0 });
        fctx.body.push({ op: "f64.lt" });
        fctx.body.push({ op: "local.get", index: lenF64 });
        fctx.body.push({ op: "f64.const", value: 9007199254740991 }); // 2^53 - 1
        fctx.body.push({ op: "f64.gt" });
        fctx.body.push({ op: "i32.or" });

        // Check: offset + length > bufferByteLength
        if (isStructBuf) {
          fctx.body.push({ op: "local.get", index: offsetF64 });
          fctx.body.push({ op: "local.get", index: lenF64 });
          fctx.body.push({ op: "f64.add" });
          fctx.body.push({ op: "local.get", index: bufLocal });
          fctx.body.push({
            op: "struct.get",
            typeIdx: vecTypeIdx,
            fieldIdx: 0,
          });
          fctx.body.push({ op: "f64.convert_i32_s" });
          fctx.body.push({ op: "f64.gt" });
          fctx.body.push({ op: "i32.or" });
        }

        {
          const rangeErrMsg = "RangeError: Invalid DataView length";
          addStringConstantGlobal(ctx, rangeErrMsg);
          const tagIdx = ensureExnTag(ctx);
          fctx.body.push({
            op: "if",
            blockType: { kind: "empty" },
            then: [...stringConstantExternrefInstrs(ctx, rangeErrMsg), { op: "throw", tagIdx } as Instr],
            else: [],
          });
        }
      } else if (isStructBuf) {
        // Default byteLength = bufferByteLength - offset
        fctx.body.push({ op: "local.get", index: bufLocal });
        fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
        fctx.body.push({ op: "f64.convert_i32_s" });
        fctx.body.push({ op: "local.get", index: offsetF64 });
        fctx.body.push({ op: "f64.sub" });
        fctx.body.push({ op: "local.set", index: lenF64 });
      } else {
        // externref buffer — we can't read length at compile time. Use a
        // NaN sentinel; the runtime __dv_register_view handler treats NaN as
        // "compute from __dv_byte_len(buf) - offset" at dispatch time.
        fctx.body.push({ op: "f64.const", value: NaN });
        fctx.body.push({ op: "local.set", index: lenF64 });
      }

      // #1064: register view metadata with host so the runtime bridge can
      // reconstruct a correctly-windowed native DataView on method dispatch.
      // Always register, even for externref buffers — ArrayBuffer variables
      // in user code are lowered to externref (see checker/type-mapper.ts),
      // but the actual wasmGC struct is what the bridge dispatches on.
      {
        const regIdx = ensureLateImport(
          ctx,
          "__dv_register_view",
          [{ kind: "externref" }, { kind: "f64" }, { kind: "f64" }],
          [],
        );
        flushLateImportShifts(ctx, fctx);
        if (regIdx !== undefined) {
          fctx.body.push({ op: "local.get", index: bufLocal });
          if (isStructBuf) {
            fctx.body.push({ op: "extern.convert_any" });
          }
          fctx.body.push({ op: "local.get", index: offsetF64 });
          fctx.body.push({ op: "local.get", index: lenF64 });
          fctx.body.push({ op: "call", funcIdx: regIdx });
        }
      }

      // Restore buffer on stack
      fctx.body.push({ op: "local.get", index: bufLocal });
      if (isStructBuf) return resultType!;
      if (resultType) return resultType;
      return { kind: "ref_null", typeIdx: vecTypeIdx };
    } else {
      // No buffer — create empty ArrayBuffer-like vec
      const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
      fctx.body.push({ op: "i32.const", value: 0 });
      fctx.body.push({ op: "i32.const", value: 0 });
      fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
      fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
      return { kind: "ref_null", typeIdx: vecTypeIdx };
    }
  }

  // new Array() / new Array(n) / new Array(a, b, c)
  if (className === "Array") {
    // Use contextual type (from variable declaration) if available, else expression type.
    // `new Array()` without type args gives Array<any>, but `var a: number[] = new Array()`
    // needs to produce Array<number> to match the variable's vec type.
    const ctxType = ctx.checker.getContextualType(expr);
    const exprType = ctxType ?? ctx.checker.getTypeAtLocation(expr);
    // If element type is `any` (no contextual type, no explicit type arg),
    // infer from how the array variable is used: scan element assignments
    // like arr[i] = value and arr.push(value) to determine the element type.
    let inferredElemWasm: ValType | null = null;
    const rawTypeArgs = ctx.checker.getTypeArguments(exprType as ts.TypeReference);
    if (rawTypeArgs?.[0] && rawTypeArgs[0].flags & ts.TypeFlags.Any) {
      const inferredElemTsType = inferArrayElementType(ctx, expr);
      if (inferredElemTsType) {
        inferredElemWasm = resolveWasmType(ctx, inferredElemTsType);
      }
    }

    let vecTypeIdx: number;
    let arrTypeIdx: number;
    let elemWasm: ValType;
    if (inferredElemWasm) {
      // Use inferred element type to register/find the right vec type
      const elemKey =
        inferredElemWasm.kind === "ref" || inferredElemWasm.kind === "ref_null"
          ? `ref_${(inferredElemWasm as { typeIdx: number }).typeIdx}`
          : inferredElemWasm.kind;
      vecTypeIdx = getOrRegisterVecType(ctx, elemKey, inferredElemWasm);
      arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
      elemWasm = inferredElemWasm;
    } else {
      const resolved = resolveWasmType(ctx, exprType);
      vecTypeIdx = (resolved as { typeIdx: number }).typeIdx;
      arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
      const typeArgs = ctx.checker.getTypeArguments(exprType as ts.TypeReference);
      const elemTsType = typeArgs?.[0];
      elemWasm = elemTsType ? resolveWasmType(ctx, elemTsType) : { kind: "f64" };
    }

    // #1197: i32-specialized number[] override — caller (variable-declaration
    // codegen) flagged this `new Array(...)` as belonging to an i32-specialized
    // local. Override the element kind from f64 to i32. We must also re-resolve
    // vecTypeIdx/arrTypeIdx through the i32 registration.
    if (
      elemWasm.kind === "f64" &&
      (ctx as unknown as { _i32ElemArrayOverride?: boolean })._i32ElemArrayOverride === true
    ) {
      elemWasm = { kind: "i32" };
      vecTypeIdx = getOrRegisterVecType(ctx, "i32", { kind: "i32" });
      arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
    }

    if (arrTypeIdx < 0) {
      // Fallback: use externref vec type for Array<any> or unresolvable element types
      vecTypeIdx = getOrRegisterVecType(ctx, "externref", {
        kind: "externref",
      });
      arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
      elemWasm = { kind: "externref" };
    }

    const args = expr.arguments ?? [];

    if (args.length === 0) {
      // new Array() → empty array with default backing capacity
      // JS arrays are dynamically resizable; wasm arrays are fixed-size.
      // Allocate a default backing buffer so index assignments work.
      const DEFAULT_CAPACITY = 64;
      fctx.body.push({ op: "i32.const", value: 0 }); // length = 0
      fctx.body.push({ op: "i32.const", value: DEFAULT_CAPACITY });
      fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
      fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
      return { kind: "ref_null", typeIdx: vecTypeIdx };
    }

    if (args.length === 1) {
      // new Array(n) → array with capacity n, length 0
      // For test262 patterns like `var a = new Array(16); a[0] = x;`
      // we create an array of size n with default values and set length to n
      // (JS semantics: sparse array with length n, all slots undefined)
      compileExpression(ctx, fctx, args[0]!, { kind: "f64" });

      // RangeError validation: n must be a non-negative integer < 2^32
      // Check: n != floor(n) || n < 0 || n >= 2^32 → throw RangeError
      const nF64Local = allocLocal(fctx, `__arr_n_f64_${fctx.locals.length}`, {
        kind: "f64",
      });
      fctx.body.push({ op: "local.tee", index: nF64Local });
      // Check n != floor(n) (non-integer or NaN)
      fctx.body.push({ op: "local.get", index: nF64Local });
      fctx.body.push({ op: "f64.floor" });
      fctx.body.push({ op: "f64.ne" });
      // Check n < 0
      fctx.body.push({ op: "local.get", index: nF64Local });
      fctx.body.push({ op: "f64.const", value: 0 });
      fctx.body.push({ op: "f64.lt" });
      fctx.body.push({ op: "i32.or" });
      // Check n >= 2^32
      fctx.body.push({ op: "local.get", index: nF64Local });
      fctx.body.push({ op: "f64.const", value: 4294967296 });
      fctx.body.push({ op: "f64.ge" });
      fctx.body.push({ op: "i32.or" });
      // If any check true, throw RangeError
      {
        const rangeErrMsg = "RangeError: Invalid array length";
        addStringConstantGlobal(ctx, rangeErrMsg);
        const tagIdx = ensureExnTag(ctx);
        fctx.body.push({
          op: "if",
          blockType: { kind: "empty" },
          then: [...stringConstantExternrefInstrs(ctx, rangeErrMsg), { op: "throw", tagIdx } as Instr],
          else: [],
        });
      }

      fctx.body.push({ op: "local.get", index: nF64Local });
      fctx.body.push({ op: "i32.trunc_sat_f64_s" });
      const sizeLocal = allocLocal(fctx, `__arr_size_${fctx.locals.length}`, {
        kind: "i32",
      });
      fctx.body.push({ op: "local.tee", index: sizeLocal });
      fctx.body.push({ op: "local.get", index: sizeLocal });
      fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
      fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
      return { kind: "ref_null", typeIdx: vecTypeIdx };
    }

    // new Array(a, b, c) → [a, b, c]
    for (const arg of args) {
      compileExpression(ctx, fctx, arg, elemWasm);
    }
    fctx.body.push({
      op: "array.new_fixed",
      typeIdx: arrTypeIdx,
      length: args.length,
    });
    const tmpData = allocLocal(fctx, `__arr_data_${fctx.locals.length}`, {
      kind: "ref",
      typeIdx: arrTypeIdx,
    });
    fctx.body.push({ op: "local.set", index: tmpData });
    fctx.body.push({ op: "i32.const", value: args.length });
    fctx.body.push({ op: "local.get", index: tmpData });
    fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
    return { kind: "ref_null", typeIdx: vecTypeIdx };
  }

  reportError(ctx, expr, `Unsupported new expression for class: ${className}`);
  return null;
}

/**
 * #1654 — `new Uint8Array(arrayBuffer)`: copy the ArrayBuffer's bytes into the
 * TypedArray backing array.
 *
 * The ArrayBuffer / DataView is backed by an `i32_byte` vec (field 0 = length,
 * field 1 = array of i32, one byte per element). User code lowers ArrayBuffer
 * variables to externref, so recover the struct via any.convert_extern +
 * ref.cast, read its length, allocate a destination array of that length, and
 * copy byte-by-byte. Returns true on success; false to let the caller fall back
 * to the numeric-length path.
 */
function emitTypedArrayFromByteBuffer(
  ctx: CodegenContext,
  fctx: FunctionContext,
  bufExpr: ts.Expression,
  dstVecTypeIdx: number,
  dstArrTypeIdx: number,
): boolean {
  const srcVecTypeIdx = getOrRegisterVecType(ctx, "i32_byte", { kind: "i32" });
  const srcArrTypeIdx = getArrTypeIdxFromVec(ctx, srcVecTypeIdx);
  if (srcArrTypeIdx < 0 || dstArrTypeIdx < 0) return false;

  // Compile the buffer expression and recover the i32_byte vec struct.
  const bufType = compileExpression(ctx, fctx, bufExpr);
  if (!bufType) return false;
  if (bufType.kind === "externref") {
    fctx.body.push({ op: "any.convert_extern" } as Instr);
    fctx.body.push({ op: "ref.cast", typeIdx: srcVecTypeIdx } as Instr);
  } else if (bufType.kind === "ref" || bufType.kind === "ref_null") {
    if ("typeIdx" in bufType && bufType.typeIdx !== srcVecTypeIdx) {
      fctx.body.push({ op: "ref.cast", typeIdx: srcVecTypeIdx } as Instr);
    }
  } else {
    fctx.body.push({ op: "drop" } as Instr);
    return false;
  }
  const srcVecLocal = allocLocal(fctx, `__tab_src_${fctx.locals.length}`, {
    kind: "ref",
    typeIdx: srcVecTypeIdx,
  });
  fctx.body.push({ op: "local.set", index: srcVecLocal });

  // len = src.length (field 0)
  const lenLocal = allocLocal(fctx, `__tab_len_${fctx.locals.length}`, {
    kind: "i32",
  });
  fctx.body.push({ op: "local.get", index: srcVecLocal });
  fctx.body.push({
    op: "struct.get",
    typeIdx: srcVecTypeIdx,
    fieldIdx: 0,
  } as Instr);
  fctx.body.push({ op: "local.set", index: lenLocal });

  // srcArr = src.data (field 1)
  const srcArrLocal = allocLocal(fctx, `__tab_srcarr_${fctx.locals.length}`, {
    kind: "ref",
    typeIdx: srcArrTypeIdx,
  });
  fctx.body.push({ op: "local.get", index: srcVecLocal });
  fctx.body.push({
    op: "struct.get",
    typeIdx: srcVecTypeIdx,
    fieldIdx: 1,
  } as Instr);
  fctx.body.push({ op: "local.set", index: srcArrLocal });

  const dstArrDef = ctx.mod.types[dstArrTypeIdx];
  const dstElemKind = dstArrDef?.kind === "array" ? dstArrDef.element.kind : undefined;

  // dstArr = new element[len]
  const dstArrLocal = allocLocal(fctx, `__tab_dstarr_${fctx.locals.length}`, {
    kind: "ref",
    typeIdx: dstArrTypeIdx,
  });
  fctx.body.push({ op: "local.get", index: lenLocal });
  fctx.body.push({ op: "array.new_default", typeIdx: dstArrTypeIdx } as Instr);
  fctx.body.push({ op: "local.set", index: dstArrLocal });

  // for (i = 0; i < len; i++) dstArr[i] = srcArr[i] converted to dst element type.
  const iLocal = allocLocal(fctx, `__tab_i_${fctx.locals.length}`, {
    kind: "i32",
  });
  fctx.body.push({ op: "i32.const", value: 0 } as Instr);
  fctx.body.push({ op: "local.set", index: iLocal });
  const loopBody: Instr[] = [
    // if (i >= len) break (br 1 out of loop)
    { op: "local.get", index: iLocal } as Instr,
    { op: "local.get", index: lenLocal } as Instr,
    { op: "i32.ge_s" } as Instr,
    { op: "br_if", depth: 1 } as Instr,
    // dstArr[i] = converted srcArr[i] byte
    { op: "local.get", index: dstArrLocal } as Instr,
    { op: "local.get", index: iLocal } as Instr,
    { op: "local.get", index: srcArrLocal } as Instr,
    { op: "local.get", index: iLocal } as Instr,
    { op: "array.get", typeIdx: srcArrTypeIdx } as Instr,
    { op: "i32.const", value: 0xff } as Instr,
    { op: "i32.and" } as Instr,
    ...(dstElemKind === "f64" ? ([{ op: "f64.convert_i32_u" } as Instr] as Instr[]) : []),
    { op: "array.set", typeIdx: dstArrTypeIdx } as Instr,
    // i++
    { op: "local.get", index: iLocal } as Instr,
    { op: "i32.const", value: 1 } as Instr,
    { op: "i32.add" } as Instr,
    { op: "local.set", index: iLocal } as Instr,
    { op: "br", depth: 0 } as Instr,
  ];
  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [{ op: "loop", blockType: { kind: "empty" }, body: loopBody } as Instr],
  } as Instr);

  // struct.new dstVec(len, dstArr)
  fctx.body.push({ op: "local.get", index: lenLocal });
  fctx.body.push({ op: "local.get", index: dstArrLocal });
  fctx.body.push({ op: "struct.new", typeIdx: dstVecTypeIdx } as Instr);
  return true;
}

export {
  compileClassExpression,
  compileNewExpression,
  compileSuperElementMethodCall,
  compileSuperMethodCall,
  resolveEnclosingClassName,
};

// Register the resolveEnclosingClassName delegate so closures.ts (and others)
// can call it via shared.ts without creating an import cycle.
registerResolveEnclosingClassName(resolveEnclosingClassName);
registerCompileSuperPropertyAccess(compileSuperPropertyAccess);
registerCompileSuperElementAccess(compileSuperElementAccess);
