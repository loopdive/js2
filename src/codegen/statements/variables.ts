// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Variable declaration statement lowering.
 */
import { ts, forEachChild } from "../../ts-api.js";
import { isNullablePrimitiveType, isStringType, isVoidType } from "../../checker/type-mapper.js";
import type { Instr, ValType } from "../../ir/types.js";
import { reportError } from "../context/errors.js";
import { allocLocal, getLocalType } from "../context/locals.js";
import type { CodegenContext, FunctionContext, NullGuardFact, NullishExclusion } from "../context/types.js";
import { emitCoercedLocalSet, noJsHost } from "../expressions/helpers.js";
import { emitUndefined } from "../expressions/late-imports.js";
import { needsTdzFlag, resolveWasmType, varBindingNeedsExternrefForUndefined } from "../index.js";
import {
  objectLiteralIsStandaloneAnyObjectCarrier,
  objectLiteralSpreadTakesHostPath,
  resolveComputedKeyExpression,
} from "../literals.js";
import { ensureObjectRuntime } from "../object-runtime.js"; // (#3037 CS1a) $Object type idx for any-object carrier
import { localGlobalIdx } from "../registry/imports.js";
import {
  getOrRegisterArrayType,
  getOrRegisterSubviewType,
  getOrRegisterTaViewType,
  getOrRegisterVecType,
} from "../registry/types.js";
import { coerceType, compileExpression, valTypesMatch } from "../shared.js";
import { emitGuardedRefCast } from "../type-coercion.js";
import { emitLazyClassObjectGet } from "../expressions/extern.js";
import { compileArrayDestructuring, compileObjectDestructuring } from "./destructuring.js";
import { compileNestedClassDeclaration } from "./nested-declarations.js";
import { emitLocalTdzInit, emitTdzInit } from "./tdz.js";
import { ensureNativeStringHelpers } from "../native-strings.js";
import { compileStringBuilderInit } from "../string-builder.js";
import { tryEmitLinearU8New } from "../linear-uint8-codegen.js";

function inferArrayVecType(ctx: CodegenContext, decl: ts.VariableDeclaration): ValType | null {
  if (!ts.isIdentifier(decl.name)) return null;
  const varName = decl.name.text;

  // Walk up to the enclosing function body or source file
  let scope: ts.Node = decl;
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

  // (#2806) A write whose value type is purely `undefined` / `void` / `null`
  // must NOT pin the array's element kind to a numeric (i32) vec. The canonical
  // source is acorn's `var elt = (void 0); elt = <nodeRef>; elts.push(elt)`:
  // the binding's DECLARED type is `undefined`, but the runtime value is an AST
  // node reference. Letting `undefined` resolve the element type to i32 lowers
  // `elts` to an i32 vec, so every pushed reference coerces to i32 `0` — silently
  // dropping the node refs (#2801, the compiled-acorn `arguments` bug). Skip such
  // writes exactly like `any` (let a later concrete write pin the kind; if none,
  // the caller falls through to `any[]` → externref). Genuine numeric pushes
  // (`number`/`boolean` literals) still pin f64/i32 and keep the fast path.
  const isUnpinnableWriteType = (t: ts.Type): boolean =>
    (t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Undefined | ts.TypeFlags.Void | ts.TypeFlags.Null)) !== 0 &&
    (t.flags & ~(ts.TypeFlags.Any | ts.TypeFlags.Undefined | ts.TypeFlags.Void | ts.TypeFlags.Null)) === 0;

  function visit(node: ts.Node) {
    if (inferredElemType) return;

    // arr[i] = value
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isElementAccessExpression(node.left) &&
      ts.isIdentifier(node.left.expression) &&
      node.left.expression.text === varName
    ) {
      const valType = ctx.checker.getTypeAtLocation(node.right);
      if (!isUnpinnableWriteType(valType)) {
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
      if (!isUnpinnableWriteType(valType)) {
        inferredElemType = valType;
        return;
      }
    }

    forEachChild(node, visit);
  }

  visit(scope);
  if (!inferredElemType) return null;

  // Resolve the inferred element type to a wasm type, then register the vec
  const elemWasm = resolveWasmType(ctx, inferredElemType);
  const elemKey =
    elemWasm.kind === "ref" || elemWasm.kind === "ref_null"
      ? `ref_${(elemWasm as { typeIdx: number }).typeIdx}`
      : elemWasm.kind;
  const vecTypeIdx = getOrRegisterVecType(ctx, elemKey, elemWasm);
  return { kind: "ref_null", typeIdx: vecTypeIdx };
}

/** String methods that return a host array (externref) rather than a wasm GC array.
 *  Variables initialized from these calls use externref instead of the GC vec struct
 *  that resolveWasmType would produce for the TS return type (e.g. string[]). */
const HOST_ARRAY_STRING_METHODS = new Set(["split"]);

function localTypeForDeclaration(ctx: CodegenContext, type: ts.Type, decl?: ts.VariableDeclaration): ValType {
  if (isNullablePrimitiveType(type)) return { kind: "externref" };
  // (#2806) A `var x = (void 0)` binding needs an externref slot (the same one
  // `= undefined` gets), so a later reference assignment isn't coerced to numeric
  // `0`. Shared with the var-hoister so the hoisted slot and this declaration path
  // agree (a `var` reuses its hoisted slot). NARROW: void-EXPRESSION initializer
  // only — a bare `undefined`-typed binding (e.g. an optional-property read) must
  // stay numeric for the delete/undefined f64-sentinel machinery (#1112). See
  // `varBindingNeedsExternrefForUndefined`.
  if (varBindingNeedsExternrefForUndefined(decl)) return { kind: "externref" };
  return resolveWasmType(ctx, type);
}

/**
 * (#2864 F1b) Resolve the wasm ValType a body-local would receive **in the
 * native-generator resume function**, so the generator's spill field, its
 * resume-load local, and the state-struct init default can all be minted at the
 * local's actual type (object / string / typed-struct locals carried across a
 * `yield`), not the historical f64.
 *
 * The resume function compiles the generator body with a FRESH FunctionContext
 * whose analysis caches (`i32CoercedLocals`, `i32SpecializedArrays`,
 * `pendingStringBuilders`, …) are empty and whose locals never resolve to a
 * module global (the spill is always a local shadow). So the type the resume
 * var-declaration computes reduces to the **fctx-independent** subset of the
 * `compileVariableStatement` cascade: the ctx/AST externref-forcing overrides
 * plus `localTypeForDeclaration`. This helper replicates exactly that subset and
 * returns `null` for any form whose representation the up-front spill layout
 * cannot match (the caller then keeps the whole generator on the host path — a
 * conservative, non-regressing bail). Returning `null` for non-nullable `ref`
 * types is deliberate: the state-struct field needs a valid default value at
 * construction, and only `ref_null` refs have one (`ref.null`).
 */
export function resolveSpillLocalValType(ctx: CodegenContext, decl: ts.VariableDeclaration): ValType | null {
  if (!ts.isIdentifier(decl.name)) return null;
  const name = decl.name.text;
  // Names the main-body analysis already routed to a host / externref slot
  // (accessor literal, host-spread literal, growable / out-of-shape object).
  if (ctx.externrefAccessorVars.has(name)) return { kind: "externref" };
  if (ctx.growableObjectLiteralVars.has(name)) return { kind: "externref" };
  // A var whose properties were widened (empty-obj + later prop writes) gets a
  // synthesized struct; mirror it if the struct is registered, else bail.
  const widenedStructName = ctx.widenedVarStructMap.get(name);
  if (widenedStructName !== undefined) {
    const idx = ctx.structMap.get(widenedStructName);
    return idx === undefined ? null : { kind: "ref_null", typeIdx: idx };
  }
  const init = decl.initializer;
  if (init) {
    if (ts.isObjectLiteralExpression(init)) {
      const forcesHostObject = init.properties.some(
        (p) =>
          ts.isGetAccessorDeclaration(p) ||
          ts.isSetAccessorDeclaration(p) ||
          (ts.isMethodDeclaration(p) && ts.isComputedPropertyName(p.name)) ||
          (ts.isPropertyAssignment(p) && p.name !== undefined && ts.isComputedPropertyName(p.name)),
      );
      if (forcesHostObject) return { kind: "externref" };
      if (objectLiteralSpreadTakesHostPath(ctx, init)) return { kind: "externref" };
    }
    if (isProxyConstruction(init)) return { kind: "externref" };
    // Representations the var-decl path computes from a decl/receiver-driven
    // inference that diverges from resolveWasmType — defer to the host path.
    if (inferStandaloneRegExpMatchArrayType(ctx, init) !== null) return null;
    const unwrapped = stripInferenceWrapper(init);
    if (
      ts.isCallExpression(unwrapped) &&
      ts.isPropertyAccessExpression(unwrapped.expression) &&
      unwrapped.expression.name.text === "subarray"
    ) {
      return null;
    }
    if (isPromiseHostCall(ctx, init) || isBindHostCall(init) || isStringMethodReturningHostArray(ctx, init)) {
      return null;
    }
  }
  const varType = ctx.checker.getTypeAtLocation(decl);
  // Array<any> takes a decl-driven vec inference (inferArrayVecType) ≠ the
  // generic resolveWasmType vec — defer.
  if (varType.flags & ts.TypeFlags.Object) {
    const sym = (varType as ts.TypeReference).symbol ?? varType.symbol;
    if (sym?.name === "Array") {
      const typeArgs = ctx.checker.getTypeArguments(varType as ts.TypeReference);
      if (typeArgs?.[0] && typeArgs[0].flags & ts.TypeFlags.Any) return null;
    }
  }
  const t = localTypeForDeclaration(ctx, varType, decl);
  switch (t.kind) {
    case "f64":
    case "i32":
    case "i64":
    case "externref":
    case "ref_null":
      return t;
    // A non-nullable `ref` has no struct-construction default and a wasm local is
    // widened to nullable anyway, so carry it as `ref_null` — the same type the
    // resume var-declaration's slot settles on (the spill field, load local, and
    // init default then all agree; reads `struct.get` a nullable ref, which is
    // valid and traps-on-null exactly as the source semantics require).
    case "ref":
      return { kind: "ref_null", typeIdx: t.typeIdx };
    default:
      return null;
  }
}

function stripInferenceWrapper(expr: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(expr) ||
    ts.isAsExpression(expr) ||
    ts.isTypeAssertionExpression(expr) ||
    ts.isSatisfiesExpression(expr) ||
    ts.isNonNullExpression(expr)
  ) {
    expr = (
      expr as
        | ts.ParenthesizedExpression
        | ts.AsExpression
        | ts.TypeAssertion
        | ts.SatisfiesExpression
        | ts.NonNullExpression
    ).expression;
  }
  return expr;
}

function isStaticRegExpExpression(ctx: CodegenContext, expr: ts.Expression): boolean {
  const unwrapped = stripInferenceWrapper(expr);
  if (unwrapped.kind === ts.SyntaxKind.RegularExpressionLiteral) return true;
  if (ts.isNewExpression(unwrapped) || (ts.isCallExpression(unwrapped) && !unwrapped.questionDotToken)) {
    const callee = stripInferenceWrapper(unwrapped.expression);
    return ts.isIdentifier(callee) && callee.text === "RegExp";
  }
  if (ts.isIdentifier(unwrapped)) {
    const sym = ctx.checker.getSymbolAtLocation(unwrapped);
    const decl = sym?.getDeclarations()?.find((d) => ts.isVariableDeclaration(d)) as ts.VariableDeclaration | undefined;
    return decl?.initializer !== undefined && isStaticRegExpExpression(ctx, decl.initializer);
  }
  return false;
}

function nativeStringVecType(ctx: CodegenContext): ValType | null {
  if (!ctx.nativeStrings || ctx.anyStrTypeIdx < 0) return null;
  const elemKey = `ref_${ctx.anyStrTypeIdx}`;
  const elemType: ValType = { kind: "ref_null", typeIdx: ctx.anyStrTypeIdx };
  getOrRegisterArrayType(ctx, elemKey, elemType);
  const vecTypeIdx = getOrRegisterVecType(ctx, elemKey, elemType);
  return { kind: "ref_null", typeIdx: vecTypeIdx };
}

function inferStandaloneRegExpMatchArrayType(
  ctx: CodegenContext,
  initializer: ts.Expression | undefined,
): ValType | null {
  if (!ctx.standalone || !initializer) return null;
  const unwrapped = stripInferenceWrapper(initializer);
  if (!ts.isCallExpression(unwrapped)) return null;
  if (!ts.isPropertyAccessExpression(unwrapped.expression)) return null;
  const method = unwrapped.expression.name.text;
  if (method === "exec") {
    return isStaticRegExpExpression(ctx, unwrapped.expression.expression) ? nativeStringVecType(ctx) : null;
  }
  if (method === "match" && unwrapped.arguments.length === 1) {
    return isStaticRegExpExpression(ctx, unwrapped.arguments[0]!) ? nativeStringVecType(ctx) : null;
  }
  return null;
}

/**
 * (#2357/#47) A `let s = <typedArray>.subarray(...)` binding in standalone/WASI
 * mode holds a `$__subview` that shares the parent's backing array (true aliasing).
 * Resolve the binding's local type to that subview here — at the real
 * variable-declaration site — so the local can hold the `struct.new $__subview` the
 * subarray lowering emits, and so element access on `s` picks the windowed lowering
 * at compile time. The receiver's element kind comes from its struct name
 * (`__vec_<elem>` for a plain typed array, `__subview_<elem>` for a nested
 * subarray). The subview type is reserved up-front (idx-stable), so this returns the
 * same index the lowering + inference use. `slice` is excluded — it returns an
 * independent copy (a plain vec), not a view.
 */
function inferSubarraySubviewType(
  ctx: CodegenContext,
  fctx: FunctionContext,
  initializer: ts.Expression | undefined,
): ValType | null {
  if (!(ctx.standalone || ctx.wasi) || !initializer) return null;
  const unwrapped = stripInferenceWrapper(initializer);
  if (!ts.isCallExpression(unwrapped) || !ts.isPropertyAccessExpression(unwrapped.expression)) return null;
  if (unwrapped.expression.name.text !== "subarray") return null;
  const receiver = unwrapped.expression.expression;
  let receiverType: ValType | undefined;
  if (ts.isIdentifier(receiver)) {
    const localIdx = fctx.localMap.get(receiver.text);
    if (localIdx !== undefined) receiverType = getLocalType(fctx, localIdx);
  }
  receiverType ??= resolveWasmType(ctx, ctx.checker.getTypeAtLocation(receiver));
  if (receiverType.kind !== "ref" && receiverType.kind !== "ref_null") return null;
  const recvName = ctx.typeIdxToStructName.get(receiverType.typeIdx);
  const elemKind = recvName?.replace(/^__vec_/, "").replace(/^__subview_/, "");
  if (elemKind === undefined || elemKind === recvName) return null;
  return { kind: "ref_null", typeIdx: getOrRegisterSubviewType(ctx, elemKind) };
}

const TA_VIEW_CTOR_NAMES = new Set([
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

/**
 * (#3054 B1) A `const a = new <TA>(buffer)` binding in standalone/WASI mode holds
 * a shared-backing `$__ta_view` that refs the ArrayBuffer's vec (not a copy), so
 * sibling views / DataViews observe each other's writes. Resolve the binding's
 * local type to that view HERE — at the variable-declaration site — so the local
 * carries the `struct.new $__ta_view` the ctor emits, and element access on `a`
 * picks the byte-decoding view lowering at compile time (rather than the native
 * vec type `resolveWasmType(Uint8Array)` would return, which would route
 * `a[i]`/`a[i]=v` through the plain-vec path and drop the aliasing). This MUST
 * mirror the ctor's own gating (`emitTaViewConstruct` / `emitTaViewConstructWindowed`
 * in `new-super.ts`): a non-numeric buffer arg (ArrayBuffer/SharedArrayBuffer/
 * DataView), host-free lane. (#3054 B2) The multi-arg windowed form
 * `new TA(buf, byteOffset[, length])` also resolves to a `$__ta_view` (with the
 * byteOffset field populated), so 1..3 args are accepted here.
 */
function inferTaViewType(ctx: CodegenContext, initializer: ts.Expression | undefined): ValType | null {
  if (!initializer) return null;
  const unwrapped = stripInferenceWrapper(initializer);
  if (!ts.isNewExpression(unwrapped) || !ts.isIdentifier(unwrapped.expression)) return null;
  const viewName = unwrapped.expression.text;
  if (!TA_VIEW_CTOR_NAMES.has(viewName)) return null;
  const args = unwrapped.arguments;
  // Buffer-backed view: single buffer arg (offset-0, B1) or windowed
  // `new TA(buf, byteOffset[, length])` (B2). A numeric first arg is the
  // count-ctor (native vec), not a view — leave it on the current path.
  if (!args || args.length < 1 || args.length > 3 || ts.isNumericLiteral(args[0]!)) return null;
  // (#1930) Query the type-oracle boundary, not the raw checker.
  const argSymName = ctx.oracle.builtinReceiverOf(args[0]!);
  // (#3097) JS-host lane: a buffer-arg TA construction routes through the host
  // construct bridge (`emitHostTaBufferConstruct`, new-super.ts) and yields a
  // REAL host TypedArray externref. The local must be externref so reads route
  // through the extern paths — coercing to the native vec type would ref.cast
  // trap. MUST stay in lock-step with `hostTaBufferArgSymName` (new-super.ts):
  // DataView buffer args are excluded there (array-like per §23.2.5.1) and
  // stay on the legacy path here too.
  if (!noJsHost(ctx)) {
    if (argSymName === "ArrayBuffer" || argSymName === "SharedArrayBuffer") return { kind: "externref" };
    return null;
  }
  if (argSymName !== "ArrayBuffer" && argSymName !== "SharedArrayBuffer" && argSymName !== "DataView") return null;
  return { kind: "ref_null", typeIdx: getOrRegisterTaViewType(ctx, viewName) };
}

function nullishLiteralKind(expr: ts.Expression): "null" | "undefined" | null {
  if (expr.kind === ts.SyntaxKind.NullKeyword) return "null";
  if (expr.kind === ts.SyntaxKind.UndefinedKeyword) return "undefined";
  if (ts.isIdentifier(expr) && expr.text === "undefined") return "undefined";
  return null;
}

function nullishPresenceOfType(type: ts.Type): { hasNull: boolean; hasUndefined: boolean } {
  let hasNull = false;
  let hasUndefined = false;
  const parts = type.isUnion() ? type.types : [type];
  for (const part of parts) {
    if (part.flags & ts.TypeFlags.Null) hasNull = true;
    if (part.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) hasUndefined = true;
  }
  return { hasNull, hasUndefined };
}

function excludesAllNullish(type: ts.Type, excludes: NullishExclusion): boolean {
  const presence = nullishPresenceOfType(type);
  if (!presence.hasNull && !presence.hasUndefined) return false;
  if (presence.hasNull && excludes === "undefined") return false;
  if (presence.hasUndefined && excludes === "null") return false;
  return true;
}

function detectNullGuardAlias(ctx: CodegenContext, expr: ts.Expression): NullGuardFact | null {
  if (!ts.isBinaryExpression(expr)) return null;
  const op = expr.operatorToken.kind;
  const isStrictNeq = op === ts.SyntaxKind.ExclamationEqualsEqualsToken;
  const isLooseNeq = op === ts.SyntaxKind.ExclamationEqualsToken;
  const isStrictEq = op === ts.SyntaxKind.EqualsEqualsEqualsToken;
  const isLooseEq = op === ts.SyntaxKind.EqualsEqualsToken;
  const isNeq = isStrictNeq || isLooseNeq;
  const isEq = isStrictEq || isLooseEq;
  if (!isNeq && !isEq) return null;

  const rightNullish = nullishLiteralKind(expr.right);
  const leftNullish = nullishLiteralKind(expr.left);
  if (!rightNullish && !leftNullish) return null;

  const comparedNullish = rightNullish ?? leftNullish;
  const nonNullSide = rightNullish ? expr.left : expr.right;
  if (!ts.isIdentifier(nonNullSide)) return null;
  const excludes: NullishExclusion = isLooseEq || isLooseNeq ? "nullish" : comparedNullish!;
  return {
    varName: nonNullSide.text,
    narrowedBranch: isNeq ? "then" : "else",
    excludes,
    provesNonNull: excludesAllNullish(ctx.checker.getTypeAtLocation(nonNullSide), excludes),
  };
}

/** Check if an expression is a string method call that returns a host array (externref). */
function isStringMethodReturningHostArray(ctx: CodegenContext, expr: ts.Expression): boolean {
  // With native strings, split returns a native string array, not externref
  if (ctx.nativeStrings && ctx.nativeStrTypeIdx >= 0) return false;
  if (!ts.isCallExpression(expr)) return false;
  if (!ts.isPropertyAccessExpression(expr.expression)) return false;
  const method = expr.expression.name.text;
  if (!HOST_ARRAY_STRING_METHODS.has(method)) return false;
  const receiverType = ctx.checker.getTypeAtLocation(expr.expression.expression);
  return isStringType(receiverType);
}

/**
 * Check if an expression is a host Promise call whose result is a real JS Promise.
 * Only matches static Promise methods (resolve/reject/all/race/allSettled/any) and
 * new Promise(). DELIBERATELY OMITS instance methods (.then/.catch/.finally) to
 * prevent cascading type overrides through Promise chains on compiled async functions.
 */
function isPromiseHostCall(_ctx: CodegenContext, expr: ts.Expression): boolean {
  // new Promise(executor)
  if (ts.isNewExpression(expr) && ts.isIdentifier(expr.expression) && expr.expression.text === "Promise") {
    return true;
  }
  if (!ts.isCallExpression(expr)) return false;
  if (!ts.isPropertyAccessExpression(expr.expression)) return false;
  const method = expr.expression.name.text;
  // Static methods: Promise.resolve/reject/all/race/allSettled/any
  if (
    ts.isIdentifier(expr.expression.expression) &&
    expr.expression.expression.text === "Promise" &&
    (method === "resolve" ||
      method === "reject" ||
      method === "all" ||
      method === "race" ||
      method === "allSettled" ||
      method === "any")
  ) {
    return true;
  }
  return false;
}

/**
 * (#2615) Check if an initializer is a `new Proxy(target, handler)` construction.
 *
 * A Proxy carries NO TypeScript-type brand — `ProxyConstructor` is typed to
 * return its TARGET type `T`, so the checker types `const p = new Proxy(t, h)`
 * as `T` (e.g. the object-literal struct of `t`). The `new Proxy` codegen
 * (new-super.ts) correctly returns `{ kind: "externref" }` (host) / the native
 * `$Proxy` externref (standalone) — but if the receiving local is slotted as
 * the target's WasmGC struct type, the externref is coerced into that struct
 * with `any.convert_extern` + `ref.test (ref <struct>)`, which FAILS for a
 * host/native Proxy (it is not that struct). The value becomes `ref.null`, and
 * the subsequent `p.attr` lowers to a direct `struct.get` on the null/struct
 * local → traps (empty-message Wasm trap). `"k" in p` works only because it
 * routes via `__extern_has`.
 *
 * The fix: force the local's storage ValType to `externref` for a `new Proxy`
 * initializer, so member reads/writes/has/delete lower through the dynamic
 * boundary helpers (`__extern_get` / `__extern_set` / `__extern_has`), which
 * are the only paths that run the Proxy MOP (the trap). Mirrors the
 * `isBindHostCall` / `isPromiseHostCall` slot-type overrides. Mode-agnostic:
 * both host and standalone emit a Proxy externref, so both need the override.
 */
function isProxyConstruction(expr: ts.Expression): boolean {
  return ts.isNewExpression(expr) && ts.isIdentifier(expr.expression) && expr.expression.text === "Proxy";
}

/**
 * (#2615 narrowing) Does the Proxy-bound variable `name` ever ESCAPE into a
 * call/new as a by-value argument, or get used as a generic-method receiver
 * (`Array.prototype.X.call(p, …)` / `Object.getPrototypeOf(p)` /
 * `Object.prototype.toString.call(p)`) anywhere in the enclosing function?
 *
 * Why this matters: forcing the slot to `externref` (so member READS route
 * through `__extern_get` — the read-trap fix) breaks the regression cases where
 * the Proxy is handed to a host generic-method / global. For a struct-typed
 * slot those host paths received a wasm struct they could introspect (IsArray,
 * getPrototypeOf, the Array.prototype.* spec walk); the bare externref Proxy
 * goes through a different host path that loses Array-ness / prototype identity
 * (regressed `Object/prototype/toString/proxy-array`, `copyWithin/*-proxy-*`,
 * `getOwnPropertySymbols/proxy-invariant-*`, `getPrototypeOf/*-target-is-proxy`).
 *
 * So: only flip the slot to externref when the Proxy stays LOCAL and is used
 * purely in member position (`p.x` / `p[k]` / `delete p.x` / `k in p`). If it
 * escapes into a call argument, keep the struct typing — the keystone read-trap
 * fix still lands for the common direct-read case, and the escaping-into-host
 * paths keep working. A receiver of `p.method()` (member-then-call) is NOT an
 * escape; only `p` appearing as a CALL/NEW ARGUMENT (incl. `.call`/`.apply`
 * first arg) counts.
 */
function proxyResultEscapesToCall(decl: ts.VariableDeclaration, name: string): boolean {
  const fn = findEnclosingFunctionOrSource(decl);
  if (!fn) return false;
  let escapes = false;
  const visit = (node: ts.Node): void => {
    if (escapes) return;
    if (ts.isIdentifier(node) && node.text === name) {
      const p = node.parent;
      // `f(…, p, …)` or `new C(…, p, …)` — p is a by-value argument.
      if ((ts.isCallExpression(p) || ts.isNewExpression(p)) && p.arguments?.some((a) => a === node)) {
        escapes = true;
        return;
      }
      // `<receiver>.call(p, …)` / `<receiver>.apply(p, …)` — p is the `this`
      // arg of a generic-method dispatch (Array.prototype.X.call(p), etc.).
      if (
        ts.isCallExpression(p) &&
        ts.isPropertyAccessExpression(p.expression) &&
        (p.expression.name.text === "call" || p.expression.name.text === "apply") &&
        p.arguments?.[0] === node
      ) {
        escapes = true;
        return;
      }
    }
    node.forEachChild(visit);
  };
  visit(fn);
  return escapes;
}

function findEnclosingFunctionOrSource(node: ts.Node): ts.Node | undefined {
  let n: ts.Node | undefined = node.parent;
  while (n) {
    if (
      ts.isFunctionDeclaration(n) ||
      ts.isFunctionExpression(n) ||
      ts.isArrowFunction(n) ||
      ts.isMethodDeclaration(n) ||
      ts.isConstructorDeclaration(n) ||
      ts.isGetAccessorDeclaration(n) ||
      ts.isSetAccessorDeclaration(n) ||
      ts.isSourceFile(n)
    ) {
      return n;
    }
    n = n.parent;
  }
  return undefined;
}

/**
 * (#1337) Check if an initializer is a `Function.prototype.bind` call whose
 * result is a real JS bound-function exotic (externref), NOT a wasm closure
 * struct. In JS-host mode `fn.bind(...)` / `Function.prototype.bind.call(fn, ...)`
 * lower to `__bind_function` which returns a host bound function as externref.
 *
 * Such a variable MUST get an `externref` local — `resolveWasmType` would
 * otherwise type it as the target function's closure-struct ref (TS infers the
 * bound result's type from the target's call signature), and the subsequent
 * `coerceType(externref → struct ref)` emits a `ref.cast` that traps on the JS
 * function, nulling the binding (the LHS-coerce blocker documented in #1337).
 * With an externref local the value round-trips intact and calling it routes
 * through the host externref-callee dispatch.
 *
 * Standalone mode degrades bind to identity (returns the receiver unchanged),
 * so this override is intentionally scoped to JS-host mode by the caller.
 */
function isBindHostCall(expr: ts.Expression): boolean {
  if (!ts.isCallExpression(expr)) return false;
  const callee = expr.expression;
  if (!ts.isPropertyAccessExpression(callee)) return false;
  // Direct form: `<receiver>.bind(...)`.
  if (callee.name.text === "bind") return true;
  // Indirect form: `Function.prototype.bind.call(fn, ...)`.
  if (
    callee.name.text === "call" &&
    ts.isPropertyAccessExpression(callee.expression) &&
    callee.expression.name.text === "bind" &&
    ts.isPropertyAccessExpression(callee.expression.expression) &&
    callee.expression.expression.name.text === "prototype" &&
    ts.isIdentifier(callee.expression.expression.expression) &&
    callee.expression.expression.expression.text === "Function"
  ) {
    return true;
  }
  return false;
}

export function compileVariableStatement(ctx: CodegenContext, fctx: FunctionContext, stmt: ts.VariableStatement): void {
  for (const decl of stmt.declarationList.declarations) {
    if (ts.isObjectBindingPattern(decl.name)) {
      compileObjectDestructuring(ctx, fctx, decl);
      continue;
    }

    if (ts.isArrayBindingPattern(decl.name)) {
      compileArrayDestructuring(ctx, fctx, decl);
      continue;
    }

    if (!ts.isIdentifier(decl.name)) {
      reportError(ctx, decl, "Destructuring not supported");
      continue;
    }

    const name = decl.name.text;

    // #1690b: a `var`/`let`/`const` declaration inside a function body always
    // introduces a function-local binding (ECMA-262 §10.2.10 for `var`;
    // block scoping for let/const), which shadows any module-level global of
    // the same name. The function-body hoister has already allocated that
    // local, so it is present in `localMap`. When it is, the declaration's
    // initializer must store into the LOCAL, never the module global —
    // otherwise the inner declaration aliases and corrupts the module binding.
    // (The module-init body compiles with an empty `localMap`, so this stays
    // false there and the module-global store path is preserved.)
    const hasLocalShadow = fctx.localMap.has(name);

    // Track const bindings for runtime enforcement (assignment throws TypeError)
    if (stmt.declarationList.flags & ts.NodeFlags.Const) {
      if (!fctx.constBindings) fctx.constBindings = new Set();
      fctx.constBindings.add(name);
      if (decl.initializer) {
        const alias = detectNullGuardAlias(ctx, decl.initializer);
        if (alias) {
          if (!fctx.nullGuardAliases) fctx.nullGuardAliases = new Map();
          fctx.nullGuardAliases.set(name, alias);
        }
      }
    }

    // #1210: string-builder rewrite for `let s = "";` followed by an
    // accumulating loop. Detected pre-pass populates `pendingStringBuilders`;
    // emit the buffer-init sequence here and skip the normal local
    // allocation (the binding name is intentionally NOT placed in
    // `localMap` — `compileIdentifier` and `compileNativeStringCompoundAssignment`
    // route through `fctx.stringBuilders` instead). The TDZ flag is also
    // not allocated, since the variable is always logically initialised
    // immediately after the buffer is created.
    if (fctx.pendingStringBuilders?.has(decl)) {
      // Native string helpers (incl. __str_buf_next_cap and __str_flatten)
      // must be available before any append site emits a call to them. The
      // detector only fires under nativeStrings; ensure here too in case the
      // function body uses no other native-string helpers.
      ensureNativeStringHelpers(ctx);
      // #1761: pass presize info (final-length proof) if the detector recorded
      // it for this declaration, so the buffer is allocated once at the proven
      // length and the append sites skip the per-append cap-check.
      const presize = fctx.stringBuilderPresize?.get(decl);
      compileStringBuilderInit(ctx, fctx, name, presize);
      // Mark as initialized for any TDZ flag captured by enclosing closures.
      // (compileStringBuilderInit didn't set localMap, so emitTdzInit only
      // touches the flag local if one was already allocated by the hoist
      // pre-pass.)
      emitTdzInit(ctx, fctx, name);
      continue;
    }

    // #1886 Slice B: linear-backed Uint8Array. When the analysis proved this
    // `new Uint8Array(...)` binding is a pure I/O buffer that never escapes the
    // GC heap, back it by linear memory (a (ptr,len) pair) instead of a GC vec.
    // Like the string-builder path above, the binding name is intentionally NOT
    // placed in `localMap` — element-access/.length/I/O reads route through
    // `fctx.linearU8Buffers` (see linear-uint8-codegen.ts). The TDZ flag, if the
    // hoist pre-pass allocated one, is marked initialised.
    if (
      decl.initializer &&
      ts.isNewExpression(decl.initializer) &&
      tryEmitLinearU8New(ctx, fctx, decl.name, decl.initializer)
    ) {
      emitTdzInit(ctx, fctx, name);
      continue;
    }

    // For arrow/function expression AND class-expression initializers, compile
    // the expression first to get the actual closure struct ref type
    // (resolveWasmType returns externref for function types, but closures need
    // ref $struct).
    //
    // (#3045) Class expressions (`const C = class { ... }`) MUST also flow
    // through here. The class BODY is lowered like a declaration, but the
    // BINDING must still hold the constructor-object VALUE — otherwise the
    // (pre-hoisted, instance-struct-typed) local `$C` is never stored, so
    // reading `C` as an rvalue (passing it to a function, `Reflect.has(C, k)`,
    // `Object.prototype.hasOwnProperty.call(C, k)`, …) reads an uninitialized
    // null local → `extern.convert_any` on null → a host `Reflect.has called on
    // non-object` / `Cannot convert undefined or null to object` trap. Compiling
    // the class expression here yields the constructor value (a closure struct →
    // externref, via emitClassCtorValue), and this branch re-types the
    // pre-hoisted slot to that closure type before storing — exactly as for
    // arrow/function-expression bindings. `new C()` is unaffected (it resolves
    // the class statically via classSet, not through the binding value).
    if (
      decl.initializer &&
      (ts.isArrowFunction(decl.initializer) ||
        ts.isFunctionExpression(decl.initializer) ||
        ts.isClassExpression(decl.initializer))
    ) {
      // (#3045 Bug 2) A class expression nested in a function had its BODY
      // deferred to this in-scope path (declarations.ts). Compile its
      // constructor/method bodies NOW, with the enclosing function scope
      // (`fctx`) live and its nested functions already registered — BEFORE
      // materializing the binding value below. `compileNestedClassDeclaration`
      // runs `promoteAccessorCapturesToGlobals` for each member (enclosing-local
      // reads/writes route through module globals) then `compileClassBodies`
      // (enclosing-function calls resolve to real direct calls). This is the
      // exact path a nested class DECLARATION takes. Run it FIRST so a module
      // global added by promotion shifts the enclosing body emitted before this
      // statement — the #779a index-shift guard registers `fctx` on the shift
      // stacks inside `compileClassBodies`, exactly as the declaration path
      // relies on; the binding materialization that follows reads the same
      // class singleton, unaffected by the ordering.
      if (ts.isClassExpression(decl.initializer)) {
        const deferredSynth = ctx.anonClassExprNames.get(decl.initializer);
        if (deferredSynth !== undefined && ctx.deferredClassBodies.has(deferredSynth)) {
          compileNestedClassDeclaration(ctx, fctx, decl.initializer, deferredSynth);
        }
      }
      // (#3045 identity) Materialize a class-expression BINDING as the class's
      // canonical `__class_<Name>` singleton (identity-stable externref) rather
      // than the ctor-CLOSURE `compileClassExpression` emits. This is what makes
      // `const cls = class C {}` satisfy `new cls().m() === cls` and
      // `inst.constructor === cls`: the binding, the inner class name (`C` via
      // identifiers.ts), `instance.constructor`, and `C.staticProp` all resolve
      // to the ONE singleton. Scope is deliberately the BINDING ONLY — every
      // other class-expression-as-value context (a `new Proxy(class {}, {})`
      // target, a call argument, an inline `(class {}).f`) keeps
      // `compileClassExpression`'s callable ctor-closure, which the Proxy /
      // Function.prototype.toString host path needs (a struct singleton is not
      // callable → `proxy-class` broke when this was applied globally). Falls
      // back to `compileExpression` for a class with no singleton (externref-
      // backed builtin subclass) or an unresolved synthetic name.
      let actualType: ValType | null;
      const clsSynth = ts.isClassExpression(decl.initializer)
        ? ctx.anonClassExprNames.get(decl.initializer)
        : undefined;
      if (
        clsSynth !== undefined &&
        ctx.classObjectGlobals?.has(clsSynth) &&
        emitLazyClassObjectGet(ctx, fctx, clsSynth)
      ) {
        actualType = { kind: "externref" };
      } else {
        actualType = compileExpression(ctx, fctx, decl.initializer);
      }
      const closureType = actualType ?? { kind: "externref" as const };

      // If this is a module-level variable, also store in the module global
      // so other functions can access the closure via global.get.
      // #1690b: skip the module-global path when a function-local shadow
      // exists — the inner declaration must bind to the local, not the global.
      const modGlobalIdx = hasLocalShadow ? undefined : ctx.moduleGlobals.get(name);
      if (modGlobalIdx !== undefined) {
        // Update the global's type to match the actual closure ref type
        const globalDef = ctx.mod.globals[localGlobalIdx(ctx, modGlobalIdx)];
        if (globalDef) {
          const nullableType: ValType =
            closureType.kind === "ref"
              ? { kind: "ref_null", typeIdx: (closureType as { typeIdx: number }).typeIdx }
              : closureType;
          globalDef.type = nullableType;
          // Also fix the init expression to match the new type
          if (nullableType.kind === "ref_null") {
            globalDef.init = [{ op: "ref.null", typeIdx: (nullableType as { typeIdx: number }).typeIdx }];
          }
        }
        // Duplicate value on stack: one for the global, one for the local
        const localIdx = allocLocal(fctx, name, closureType);
        fctx.body.push({ op: "local.tee", index: localIdx });
        fctx.body.push({ op: "global.set", index: modGlobalIdx });
        // Set TDZ flag to 1 (initialized)
        emitTdzInit(ctx, fctx, name);
      } else {
        // Reuse pre-hoisted slot if it exists.
        // Do NOT narrow externref → ref: the hoisting pass already emitted
        // __get_undefined() targeting externref; mutating the type causes
        // impossible ref.cast at runtime (#962). Coercion handles it.
        const priorIdx = fctx.localMap.get(name);
        const localIdx =
          priorIdx !== undefined && priorIdx >= fctx.params.length ? priorIdx : allocLocal(fctx, name, closureType);
        if (priorIdx !== undefined && priorIdx >= fctx.params.length) {
          const slot = fctx.locals[priorIdx - fctx.params.length];
          if (slot && slot.type.kind !== "externref") slot.type = closureType;
        }
        emitCoercedLocalSet(ctx, fctx, localIdx, closureType);
      }
      continue;
    }

    // For object literal initializers with computed property names that TS
    // cannot resolve (resulting in 0 type properties), compile the expression
    // first to get the actual struct ref type. Similar to arrow function handling.
    if (
      decl.initializer &&
      ts.isObjectLiteralExpression(decl.initializer) &&
      decl.initializer.properties.some((p) => ts.isPropertyAssignment(p) && p.name && ts.isComputedPropertyName(p.name))
    ) {
      const varType2 = ctx.checker.getTypeAtLocation(decl);
      const tsProps = varType2.getProperties();
      // Only use this path when TS cannot resolve any properties
      // (i.e. all properties are computed and non-resolvable)
      const hasUnresolvedComputed = tsProps.length < decl.initializer.properties.length;
      if (hasUnresolvedComputed) {
        // Check if ALL computed keys can be resolved at compile time.
        // If so, skip this early-out and let ensureComputedPropertyFields + the
        // normal module-global path handle it properly.
        const allComputedResolvable = decl.initializer.properties.every((p) => {
          if (!ts.isPropertyAssignment(p) || !p.name || !ts.isComputedPropertyName(p.name)) return true;
          return resolveComputedKeyExpression(ctx, p.name.expression) !== undefined;
        });
        if (!allComputedResolvable) {
          const actualType = compileExpression(ctx, fctx, decl.initializer);
          const objType = actualType ?? { kind: "externref" as const };
          // Store to module global if available, otherwise local.
          // #1690b: a function-local shadow takes precedence over the global.
          const modGlobal = hasLocalShadow ? undefined : ctx.moduleGlobals.get(name);
          if (modGlobal !== undefined) {
            fctx.body.push({ op: "global.set", index: modGlobal });
            emitTdzInit(ctx, fctx, name);
          } else {
            // Reuse pre-hoisted slot if it exists.
            // Do NOT narrow externref → ref (#962).
            const priorIdx = fctx.localMap.get(name);
            const localIdx =
              priorIdx !== undefined && priorIdx >= fctx.params.length ? priorIdx : allocLocal(fctx, name, objType);
            if (priorIdx !== undefined && priorIdx >= fctx.params.length) {
              const slot = fctx.locals[priorIdx - fctx.params.length];
              if (slot && slot.type.kind !== "externref") slot.type = objType;
            }
            fctx.body.push({ op: "local.set", index: localIdx });
          }
          continue;
        }
        // All computed keys resolvable — fall through to normal path
      }
    }

    // Check if this is a module-level global (already registered).
    // #1690b: a function-local shadow (inner `var`/`let`/`const` of the same
    // name) must bind to the local, so suppress the module-global store here.
    const moduleGlobalIdx = hasLocalShadow ? undefined : ctx.moduleGlobals.get(name);
    if (moduleGlobalIdx !== undefined) {
      // Shape-inferred array-like: compile {} as empty vec struct
      const shapeInfo = ctx.shapeMap.get(name);
      if (shapeInfo && decl.initializer) {
        // Create an empty vec struct: struct.new(length=0, data=array.new_default(4))
        fctx.body.push({ op: "i32.const", value: 0 }); // length = 0
        fctx.body.push({ op: "i32.const", value: 4 }); // initial capacity
        fctx.body.push({ op: "array.new_default", typeIdx: shapeInfo.arrTypeIdx } as Instr);
        fctx.body.push({ op: "struct.new", typeIdx: shapeInfo.vecTypeIdx });
        fctx.body.push({ op: "global.set", index: moduleGlobalIdx });
        // Set TDZ flag to 1 (initialized)
        emitTdzInit(ctx, fctx, name);
        continue;
      }
      // Module global: compile initializer and set global
      if (decl.initializer) {
        const globalDef = ctx.mod.globals[localGlobalIdx(ctx, moduleGlobalIdx)];
        const wasmType = globalDef?.type ?? resolveWasmType(ctx, ctx.checker.getTypeAtLocation(decl));
        compileExpression(ctx, fctx, decl.initializer, wasmType);
        // Re-read index: compileExpression may shift globals via addStringConstantGlobal
        const moduleGlobalIdxPost = ctx.moduleGlobals.get(name)!;
        fctx.body.push({ op: "global.set", index: moduleGlobalIdxPost });
      } else {
        // No initializer: `let x;` at module level — in JS, uninitialized
        // variables are `undefined`. For externref globals, emit __get_undefined()
        // so `x === undefined` works correctly (#737).
        const globalDef = ctx.mod.globals[localGlobalIdx(ctx, moduleGlobalIdx)];
        if (globalDef?.type.kind === "externref") {
          emitUndefined(ctx, fctx);
          fctx.body.push({ op: "global.set", index: moduleGlobalIdx });
        }
      }
      // Set TDZ flag to 1 (initialized) — even for `let x;` without initializer
      emitTdzInit(ctx, fctx, name);
      continue;
    }

    const varType = ctx.checker.getTypeAtLocation(decl);
    // #1120: If this local has been detected as i32-coerced (every write
    // is wrapped in `| 0` or another bitwise int32 coercion), force its
    // Wasm type to i32. This must be checked BEFORE inferred-array logic
    // because the candidate set is gathered ahead of time and only
    // contains numeric-typed names.
    const isI32CoercedLocal =
      fctx.i32CoercedLocals?.has(name) === true && (varType.flags & ts.TypeFlags.NumberLike) !== 0;
    let inferredVecType: ValType | null = null;
    if (varType.flags & ts.TypeFlags.Object) {
      const sym = (varType as ts.TypeReference).symbol ?? (varType as ts.Type).symbol;
      if (sym?.name === "Array") {
        const typeArgs = ctx.checker.getTypeArguments(varType as ts.TypeReference);
        if (typeArgs?.[0] && typeArgs[0].flags & ts.TypeFlags.Any) {
          inferredVecType = inferArrayVecType(ctx, decl);
        }
      }
    }
    // Override type for string methods returning host arrays (e.g. split() returns
    // externref but TS types as string[] which resolveWasmType maps to GC vec struct)
    // Check if this variable has widened properties (empty obj with later prop assignments)
    const widenedStructName = ctx.widenedVarStructMap.get(name);
    const widenedTypeIdx = widenedStructName !== undefined ? ctx.structMap.get(widenedStructName) : undefined;
    // #1197: i32-specialized number[] arrays get __vec_i32 instead of __vec_f64.
    // The override is applied AFTER the standard type computation so it stacks
    // cleanly with widened/inferred paths above (the analysis pass restricts
    // candidates to bare `let arr: number[] = ...` so neither path applies).
    const isI32SpecializedArray =
      fctx.i32SpecializedArrays?.has(name) === true && (varType.flags & ts.TypeFlags.Object) !== 0;

    // (#1239) If the initializer is an object literal carrying get/set
    // accessor declarations, the variable holds a JS host object
    // (externref) — never the inferred wasmGC struct type. Tag the var
    // up-front so the local's wasm type and ctx.externrefAccessorVars
    // stay in sync; later reads/writes via resolveStructNameForExpr will
    // see the override.
    //
    // (#1433) Same routing for `[Symbol.dispose]` / `[Symbol.asyncDispose]`
    // computed methods — they reach the JS-host plain-object path so the
    // native runtime can find the disposer under the real Symbol property.
    const initIsAccessorLiteral =
      decl.initializer !== undefined &&
      ts.isObjectLiteralExpression(decl.initializer) &&
      decl.initializer.properties.some((p) => {
        if (ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p)) return true;
        if (ts.isMethodDeclaration(p) && ts.isComputedPropertyName(p.name)) {
          const inner = p.name.expression;
          if (
            ts.isPropertyAccessExpression(inner) &&
            ts.isIdentifier(inner.expression) &&
            inner.expression.text === "Symbol" &&
            (inner.name.text === "dispose" || inner.name.text === "asyncDispose")
          ) {
            return true;
          }
        }
        return false;
      });
    // (#2804) A spread-containing object literal initializer that takes the host
    // plain-object path (no concrete contextual struct type — e.g.
    // `const b = { ...a, z: 3 }`) builds a host `$Object` (externref), NOT the
    // closed struct TypeScript INFERS for the variable. The local must therefore
    // be an externref so the value isn't ref.cast to that inferred struct (which
    // fails at runtime → `b.x` reads NaN/null), and reads route through
    // `__extern_get` — preserving the spread's runtime insertion-order keys +
    // values. Uses the SAME predicate as the literals.ts routing so the local
    // representation and the value representation stay in lockstep. An explicit
    // concrete-struct annotation pins a contextual type → predicate false →
    // struct path retained (#2714 control).
    const initIsHostSpreadLiteral =
      decl.initializer !== undefined &&
      ts.isObjectLiteralExpression(decl.initializer) &&
      objectLiteralSpreadTakesHostPath(ctx, decl.initializer);
    // (#2837) A non-empty object literal that the detection pre-pass marked
    // growable (later out-of-shape / nested write) is built as an externref
    // `$Object`; the local must be externref so reads/writes route through
    // `__extern_get`/`__extern_set` (via the same `externrefAccessorVars` hook the
    // member dispatch consults), matching the value representation.
    const initIsGrowableObjectLiteral =
      decl.initializer !== undefined &&
      ts.isObjectLiteralExpression(decl.initializer) &&
      ts.isIdentifier(decl.name) &&
      ctx.growableObjectLiteralVars.has(decl.name.text);
    if (initIsAccessorLiteral || initIsHostSpreadLiteral || initIsGrowableObjectLiteral) {
      ctx.externrefAccessorVars.add(name);
    }

    const standaloneRegExpMatchArrayType = inferStandaloneRegExpMatchArrayType(ctx, decl.initializer);
    const subarraySubviewType = inferSubarraySubviewType(ctx, fctx, decl.initializer);
    // (#3054 B1) `new <TA>(buffer)` → shared-backing `$__ta_view` local type.
    const taViewType = inferTaViewType(ctx, decl.initializer);
    // (#2615) `new Proxy(...)` initializer — the slot must be externref so reads
    // route through `__extern_get` (the Proxy MOP), not a static `struct.get`.
    // NARROWED (#2615 regression fix): only when the Proxy variable stays local
    // and is member-accessed; if it escapes into a call/new argument or a
    // generic-method `.call`/`.apply` receiver, keep the struct typing so the
    // host generic-method / global paths (IsArray, getPrototypeOf, the
    // Array.prototype.* spec walk) still work on a wasm-struct receiver.
    const initIsProxy =
      decl.initializer !== undefined &&
      isProxyConstruction(decl.initializer) &&
      ts.isIdentifier(decl.name) &&
      !proxyResultEscapesToCall(decl, decl.name.text);
    // (#3037 CS1a) A spread-free, data-only object literal produced into an
    // `any`/`unknown`/`object` context (standalone) is built as an open `$Object`
    // and normally lands in an externref local — where at `===` it boxes tag-5
    // and loses `ref.eq` identity (`const o: any = {z:1}; o === o` → 0). Slot the
    // local as a raw `ref $Object` instead: the store coerces the object externref
    // to the ref (`any.convert_extern` + guarded `ref.cast $Object`), `===` then
    // boxes it **tag-6** via `boxToAny`'s `ref` arm (`__any_box_ref`, identity in
    // `refval` → the tag-6 same-tag `ref.eq` arm answers identity), and dynamic
    // `any`-typed member reads coerce the ref back to externref (`extern.convert_
    // any`) for `__extern_get`. This is the same lockstep discipline
    // `objectLiteralSpreadTakesHostPath` uses for its externref locals, and does
    // NOT touch the `===` operand seam (−299) or the generic externref boxing arm
    // (−788). Excludes growable literals (out-of-shape writes need the externref
    // dictionary carrier); accessor/spread/computed-key literals are already
    // excluded by the predicate. `objectTypeIdx` is fetched via the idempotent
    // `ensureObjectRuntime` (the literal compile forces it anyway).
    const initIsAnyObjectCarrier =
      decl.initializer !== undefined &&
      ts.isObjectLiteralExpression(decl.initializer) &&
      !(ts.isIdentifier(decl.name) && ctx.growableObjectLiteralVars.has(decl.name.text)) &&
      objectLiteralIsStandaloneAnyObjectCarrier(ctx, decl.initializer);
    const anyObjectCarrierTypeIdx = initIsAnyObjectCarrier ? ensureObjectRuntime(ctx).objectTypeIdx : -1;
    const wasmType: ValType =
      // (#3123) A widened fnctor-subclass binding (pre-hoist recorded it in
      // `fnctorWidenedLocals` — reassigned with a foreign/host value) must
      // keep its externref slot even when the block-scoped shadow machinery
      // re-allocates here (the pre-hoisted slot reuse below is gated on
      // plain-fn capture and does not fire for uncaptured bindings).
      fctx.fnctorWidenedLocals?.has(name)
        ? { kind: "externref" as const }
        : initIsAccessorLiteral || initIsHostSpreadLiteral || initIsGrowableObjectLiteral
          ? { kind: "externref" as const }
          : initIsAnyObjectCarrier && anyObjectCarrierTypeIdx >= 0
            ? { kind: "ref_null" as const, typeIdx: anyObjectCarrierTypeIdx }
            : isI32CoercedLocal
              ? { kind: "i32" }
              : isI32SpecializedArray
                ? { kind: "ref_null" as const, typeIdx: getOrRegisterVecType(ctx, "i32", { kind: "i32" }) }
                : widenedTypeIdx !== undefined
                  ? { kind: "ref_null" as const, typeIdx: widenedTypeIdx }
                  : (taViewType ??
                    subarraySubviewType ??
                    inferredVecType ??
                    standaloneRegExpMatchArrayType ??
                    (decl.initializer && isStringMethodReturningHostArray(ctx, decl.initializer)
                      ? { kind: "externref" as const }
                      : decl.initializer && isPromiseHostCall(ctx, decl.initializer)
                        ? { kind: "externref" as const }
                        : // (#2615) `new Proxy(target, handler)` returns a host/native
                          // Proxy externref. The checker types it as the TARGET's
                          // struct (ProxyConstructor returns T), so the default slot
                          // would `ref.test` the Proxy against that struct, fail, null
                          // it, and trap every read via a direct `struct.get`. Force an
                          // externref local so reads route through `__extern_get` (the
                          // only path that runs the Proxy MOP / trap). Both modes emit
                          // a Proxy externref, so this is mode-agnostic.
                          initIsProxy
                          ? { kind: "externref" as const }
                          : // (#1337) `fn.bind(...)` / `Function.prototype.bind.call(...)`
                            // returns a host bound-function externref in JS-host mode;
                            // force an externref local so the value isn't ref.cast to
                            // the target's closure struct (which traps → null binding).
                            decl.initializer && !ctx.standalone && !noJsHost(ctx) && isBindHostCall(decl.initializer)
                            ? { kind: "externref" as const }
                            : localTypeForDeclaration(ctx, varType, decl)));

    // (#2814) Bug C: re-align a block-scoped let/const with its OWN pre-hoisted
    // slot. `saveBlockScopedShadows` removed this name's localMap (and TDZ-flag)
    // entry on block entry, so without this it re-allocates a FRESH slot — but a
    // hoisted FunctionDeclaration that captured this name recorded its capture
    // against the PRE-HOISTED slot (the hoisted-fn capture path has no name-scan
    // fallback). The fresh slot then desyncs from the capture's slot, which stays
    // uninitialised → the closure reads null. When the pre-pass recorded a slot
    // for THIS exact declaration (only happens when the name had no
    // outer/param/var shadow — genuine shadows are *skipped* by the pre-pass and
    // never recorded), re-register it so the declaration reuses it via the
    // isHoistedLetConst path below (value-slot == capture-slot). Fires only when
    // the name is currently absent from localMap (i.e. it WAS shadow-removed).
    //
    // (#2814 narrowing) Reuse the pre-hoisted slot ONLY when the name is captured
    // by at least one PLAIN (non-CPS) nested function declaration and by NO
    // CPS-lowered (`async` / generator) one. Rationale:
    //   • The Bug-C desync only manifests when a hoisted FunctionDeclaration
    //     CAPTURES the block-let (it pins the capture to the pre-hoist slot). For
    //     an UNcaptured block-let the reuse fixes nothing and only perturbs which
    //     raw slot it lands in — so we don't reuse it (keeps non-Bug-C functions
    //     byte-identical to baseline).
    //   • A CPS capturer (async / generator) spills captures into a continuation
    //     state struct; collapsing the duplicate slot perturbs that lowering. The
    //     full-test262 merge_group caught 43 regressions, ALL in
    //     `for-await-of/async-{func,gen}-decl-dstr-*`, where loop-state vars
    //     (`nextCount`/`iterCount`/`iterator`/…) are read inside a for-await-of
    //     continuation — captured BOTH mutably and immutably, so a mutability gate
    //     is insufficient; the *capturer* being async/generator is the signal. If
    //     ANY CPS function captures the name, skip the reuse (the mutable boxed
    //     cell, when present, already threads the value correctly).
    // Plain sync `function f` capturers — the Bug-C cluster and the recovered
    // for-of/for `iter-close` cases — keep the reuse. The async/generator cluster
    // recovery is deferred to the architect follow-up (#2818).
    const isLetConstDecl = !!(
      decl.parent.flags &
      (ts.NodeFlags.Let | ts.NodeFlags.Const | ts.NodeFlags.Using | ts.NodeFlags.AwaitUsing)
    );
    if (isLetConstDecl && !fctx.localMap.has(name)) {
      const preHoisted = fctx.preHoistedLetConstSlots?.get(decl);
      let capturedByPlainFn = false;
      let cpsCaptured = false;
      for (const [capturerName, caps] of ctx.nestedFuncCaptures) {
        if (!caps.some((c) => c.name === name)) continue;
        if ((ctx.asyncFunctions?.has(capturerName) ?? false) || (ctx.generatorFunctions?.has(capturerName) ?? false)) {
          cpsCaptured = true;
          break;
        }
        capturedByPlainFn = true;
      }
      if (capturedByPlainFn && !cpsCaptured && preHoisted !== undefined && preHoisted.valueSlot >= fctx.params.length) {
        fctx.localMap.set(name, preHoisted.valueSlot);
        if (preHoisted.flagSlot !== undefined) {
          if (!fctx.tdzFlagLocals) fctx.tdzFlagLocals = new Map();
          fctx.tdzFlagLocals.set(name, preHoisted.flagSlot);
        }
      }
    }

    // If this var/let/const was already pre-hoisted at function entry, reuse that slot.
    // For let/const: the pre-pass (hoistLetConstWithTdz) always pre-allocates a slot
    // regardless of whether a TDZ flag is also allocated, so we check only the localMap.
    const existingIdx = fctx.localMap.get(name);
    // (#1672) An object/class literal initializer whose method/accessor body
    // references THIS same variable (e.g. `var obj = { async *m() { ...obj... } }`)
    // triggers `promoteAccessorCapturesToGlobals` MID-evaluation: it copies the
    // pre-assignment local value into a fresh `__captured_<name>` global, then
    // deletes `name` from `localMap` so later reads resolve via that global.
    // The problem: the promotion copies the STALE value (whatever the local held
    // before this declaration), and the subsequent store writes only the LOCAL.
    // Every later read of `name` then sees the stale global, not the freshly
    // built object — so `obj.method` misses the method and dynamic dispatch
    // returns null. Record whether the name was already a captured global before
    // the initializer runs; if promotion adds it during the initializer, we
    // re-sync the global from the local after the store below.
    const wasCapturedGlobalBefore = ctx.capturedGlobals.has(name);
    // #1177: `using`/`await using` declarations are NOT `var` — they have
    // block-scoped lifetimes and TDZ semantics like let/const.
    const isVar = !(
      decl.parent.flags &
      (ts.NodeFlags.Let | ts.NodeFlags.Const | ts.NodeFlags.Using | ts.NodeFlags.AwaitUsing)
    );
    const isHoistedLetConst = !isVar && existingIdx !== undefined && existingIdx >= fctx.params.length;
    const freshLocalForLetConst = !isVar && !isHoistedLetConst;
    const localIdx =
      (isVar || isHoistedLetConst) && existingIdx !== undefined && existingIdx >= fctx.params.length
        ? existingIdx
        : allocLocal(fctx, name, wasmType);

    // (#3037 CS1a) A let/const any-object-carrier reuses a slot the hoist pre-pass
    // pre-allocated as externref (from `resolveWasmType(any)`), so the `wasmType`
    // above (ref $Object) is bypassed. Retype the reused slot to the `$Object` ref
    // so the value boxes tag-6 at `===` (identity) while reads coerce back to
    // externref — the same fixup the initializer-driven ref upgrade (below) does,
    // applied up front for the carrier. Skip closure-captured slots (a boxed /
    // promoted-global capture threads the value through a cell/global of its own
    // type; leave those externref — safe via S3a, only under-fixes).
    if (
      initIsAnyObjectCarrier &&
      anyObjectCarrierTypeIdx >= 0 &&
      localIdx >= fctx.params.length &&
      !(fctx.boxedCaptures?.has(name) ?? false) &&
      !ctx.capturedGlobals.has(name)
    ) {
      const carrierSlot = fctx.locals[localIdx - fctx.params.length];
      if (carrierSlot && carrierSlot.type.kind === "externref") {
        carrierSlot.type = { kind: "ref_null", typeIdx: anyObjectCarrierTypeIdx };
      }
    }

    // #1607: A block-scoped let/const that did NOT reuse a pre-hoisted slot
    // (because `saveBlockScopedShadows` removed its hoisted localMap/TDZ entry
    // on block entry) gets a fresh local with no TDZ flag. A self-referential
    // initializer like `{ const x = x + 1; }` would then read the
    // zero/undefined-initialized fresh local instead of throwing a TDZ
    // ReferenceError. Re-allocate the TDZ flag here, BEFORE the initializer is
    // compiled, and zero-init it so the self-reference read fires the check.
    if (freshLocalForLetConst && needsTdzFlag(ctx, decl)) {
      if (!fctx.tdzFlagLocals) fctx.tdzFlagLocals = new Map();
      if (!fctx.tdzFlagLocals.has(name)) {
        const tdzFlagIdx = allocLocal(fctx, `__tdz_${name}`, { kind: "i32" });
        fctx.tdzFlagLocals.set(name, tdzFlagIdx);
        // Wasm i32 locals zero-init to 0 (uninitialized) automatically — no
        // explicit store needed before the initializer runs.
      }
    }

    // If we reused a pre-hoisted slot but inference found a more precise type
    // (e.g. Array<any> hoisted as vec_externref, but inferred as vec_f64),
    // update the local's type so it matches what the initializer will produce.
    // IMPORTANT: Do NOT retroactively change the type when it would invalidate
    // already-emitted initialization code:
    // - ref/ref_null → primitive: earlier struct.new would become invalid
    // - externref → ref/ref_null: hoisted __get_undefined() can't be cast (#962)
    if ((isVar || isHoistedLetConst) && existingIdx !== undefined && existingIdx >= fctx.params.length) {
      const localSlot = fctx.locals[existingIdx - fctx.params.length];
      if (
        localSlot &&
        (wasmType.kind !== localSlot.type.kind || (wasmType as any).typeIdx !== (localSlot.type as any).typeIdx)
      ) {
        const existingIsRef = localSlot.type.kind === "ref" || localSlot.type.kind === "ref_null";
        const existingIsExternref = localSlot.type.kind === "externref";
        const newIsPrimitive =
          wasmType.kind === "f64" ||
          wasmType.kind === "i32" ||
          wasmType.kind === "i64" ||
          wasmType.kind === "externref";
        const newIsRef = wasmType.kind === "ref" || wasmType.kind === "ref_null";
        // (#820c) Accessor object literals always produce externref — the
        // local's hoisted ref-struct type would force a ref.cast that fails
        // on the JS host plain object, silently nulling the captured value
        // and trapping later closures (#820c, async-gen-yield-star-*). The
        // hoist pass emits no initialization for ref-typed locals, so
        // narrowing ref → externref here is safe (no struct.new to
        // invalidate, and externref locals default to ref.null.extern which
        // is the same "undefined" sentinel a hoisted externref would carry
        // before its first assignment).
        if (initIsAccessorLiteral && existingIsRef && wasmType.kind === "externref") {
          localSlot.type = wasmType;
        } else if (initIsProxy && existingIsRef && wasmType.kind === "externref") {
          // (#2615) A `const p = new Proxy(...)` was pre-hoisted as the target's
          // struct ref (the checker types Proxy as its target T). The hoist pass
          // emits no initialization for ref-typed locals, so narrowing ref →
          // externref here is safe — and required, otherwise the Proxy externref
          // is `ref.test`-coerced into the struct slot (fails → null → trap on
          // every read). Same rationale as the accessor-literal branch above.
          localSlot.type = wasmType;
        } else if (initIsGrowableObjectLiteral && existingIsRef && wasmType.kind === "externref") {
          // (#2837) A `var o = {c:1}` later written out-of-shape was pre-hoisted as
          // the inferred closed struct, but the literal is built as an externref
          // `$Object` (so the out-of-shape write lands). Narrow the hoisted ref slot
          // to externref — required, otherwise the $Object is `ref.test`-coerced into
          // the struct slot (fails → null → every read/write lost). Same rationale as
          // the accessor-literal / Proxy branches above (hoist pass emits no init for
          // ref-typed locals, so ref → externref is safe). The default re-type guard
          // below treats externref as "primitive" and would refuse this narrowing.
          localSlot.type = wasmType;
        } else if (standaloneRegExpMatchArrayType !== null && existingIsExternref && newIsRef) {
          localSlot.type = wasmType;
        } else if (
          taViewType?.kind === "externref" &&
          existingIsRef &&
          wasmType.kind === "externref" &&
          !(fctx.boxedCaptures?.has(name) ?? false) &&
          !ctx.capturedGlobals.has(name)
        ) {
          // (#3097) JS-host `new TA(buffer, ...)` — the value is a REAL host
          // TypedArray externref (built via the host construct bridge), but the
          // var was pre-hoisted as the native vec ref. Narrow the slot to
          // externref so reads route through the extern paths; the vec-slot
          // coercion would otherwise `ref.test`-fail and materialize a COPY
          // (length preserved, aliasing lost). Safe for the same reason as the
          // accessor-literal / Proxy arms: the hoist pass emits no init for
          // ref-typed locals. Captured slots keep the vec type (the capture
          // cell/global was typed at hoist time) and fall back to the
          // guarded-materialize copy.
          localSlot.type = wasmType;
        } else if (!(existingIsRef && newIsPrimitive) && !(existingIsExternref && newIsRef)) {
          localSlot.type = wasmType;
        }
      }
    }

    if (decl.initializer) {
      // Check if the variable has a callable type (function reference).
      // If so, compile without an externref hint to preserve the closure ref type.
      const callSigs = varType.getCallSignatures?.();
      const isCallable = callSigs && callSigs.length > 0 && wasmType.kind === "externref";
      let stackType: ValType = wasmType;
      if (isCallable) {
        // Compile without type hint to get the actual closure/ref type
        const actualType = compileExpression(ctx, fctx, decl.initializer);
        const closureType = actualType ?? { kind: "externref" as const };
        // If the result is a closure ref, update the local's type — but not
        // if the local was pre-hoisted as externref (illegal cast, #962).
        if (
          (closureType.kind === "ref" || closureType.kind === "ref_null") &&
          ctx.closureInfoByTypeIdx.has((closureType as { typeIdx: number }).typeIdx)
        ) {
          if (localIdx >= fctx.params.length) {
            const localSlot = fctx.locals[localIdx - fctx.params.length];
            if (localSlot && localSlot.type.kind !== "externref") localSlot.type = closureType;
          }
          stackType = closureType;
        } else if (
          closureType.kind === "externref" &&
          !ctx.standalone &&
          !noJsHost(ctx) &&
          isBindHostCall(decl.initializer)
        ) {
          // (#1337) A `.bind(...)` result is a host bound-function exotic.
          // Keep it as externref — do NOT match-and-recast it to a wasm
          // closure struct (the JS function isn't a struct; the cast would
          // trap and null the binding). Calling it dispatches through the
          // host externref-callee path.
          if (localIdx >= fctx.params.length) {
            const localSlot = fctx.locals[localIdx - fctx.params.length];
            if (localSlot) localSlot.type = { kind: "externref" };
          }
          stackType = { kind: "externref" };
        } else if (closureType.kind === "externref" && callSigs!.length > 0) {
          // The initializer returned externref but the type is callable.
          // This happens when a function returns a closure coerced to externref.
          // Find the matching closure info by comparing the TS call signature
          // against registered closure types and unbox (any.convert_extern + ref.cast).
          const sig = callSigs![0]!;
          const sigParamCount = sig.parameters.length;
          const sigRetType = ctx.checker.getReturnTypeOfSignature(sig);
          const sigRetWasm = isVoidType(sigRetType) ? null : resolveWasmType(ctx, sigRetType);
          const sigParamWasmTypes: ValType[] = [];
          for (let i = 0; i < sigParamCount; i++) {
            const paramType = ctx.checker.getTypeOfSymbol(sig.parameters[i]!);
            sigParamWasmTypes.push(resolveWasmType(ctx, paramType));
          }

          let matchedClosureInfo:
            | { structTypeIdx: number; info: typeof ctx.closureInfoByTypeIdx extends Map<number, infer V> ? V : never }
            | undefined;
          for (const [typeIdx, info] of ctx.closureInfoByTypeIdx) {
            if (info.paramTypes.length !== sigParamCount) continue;
            if (sigRetWasm === null && info.returnType !== null) continue;
            if (sigRetWasm !== null && info.returnType === null) continue;
            if (sigRetWasm !== null && info.returnType !== null && sigRetWasm.kind !== info.returnType.kind) continue;
            let paramsMatch = true;
            for (let i = 0; i < sigParamCount; i++) {
              if (sigParamWasmTypes[i]!.kind !== info.paramTypes[i]!.kind) {
                paramsMatch = false;
                break;
              }
            }
            if (paramsMatch) {
              matchedClosureInfo = { structTypeIdx: typeIdx, info };
              break;
            }
          }

          if (matchedClosureInfo) {
            // Convert externref back to closure struct ref (guarded to avoid illegal cast)
            fctx.body.push({ op: "any.convert_extern" } as Instr);
            emitGuardedRefCast(fctx, matchedClosureInfo.structTypeIdx);
            const castType: ValType = { kind: "ref_null", typeIdx: matchedClosureInfo.structTypeIdx };
            if (localIdx >= fctx.params.length) {
              const localSlot = fctx.locals[localIdx - fctx.params.length];
              // Do NOT narrow externref → ref (#962)
              if (localSlot && localSlot.type.kind !== "externref") localSlot.type = castType;
            }
            stackType = castType;
          } else {
            stackType = closureType;
          }
        } else {
          stackType = closureType;
        }
      } else {
        // #1197: while compiling the initializer for an i32-specialized number[]
        // local, set a transient flag so the array literal / Array() constructor
        // compiler emits an i32 backing array instead of f64.
        const ctxAny = ctx as unknown as { _i32ElemArrayOverride?: boolean };
        const prevElemOverride = ctxAny._i32ElemArrayOverride;
        if (isI32SpecializedArray) ctxAny._i32ElemArrayOverride = true;
        let resultType: ValType | null;
        // (#2692) If `name` is a closure-captured-mutable boxed BEFORE this
        // declaration runs — now the common case since #2692 materializes the
        // ref-cell box eagerly at function-top, but also the #1177 case of a
        // closure constructed before the decl — then `localIdx` points at the
        // ref-cell-ref local. The initializer's VALUE type, the type hint, and
        // the coercion target must all be the box's `valType` (the inner field
        // type), NOT the box ref type. The box write itself is done by the
        // `boxedForInit`/`boxedNoInit` `struct.set` paths below; using the box
        // ref type here would coerce the value f64/externref → ref-cell (garbage
        // `ref.null; ref.as_non_null` / illegal cast). Computed once, reused.
        const boxedForInit = fctx.boxedCaptures?.get(name);
        const initializerExpectedType = boxedForInit
          ? boxedForInit.valType
          : (getLocalType(fctx, localIdx) ?? wasmType);
        try {
          resultType = compileExpression(ctx, fctx, decl.initializer, initializerExpectedType);
        } finally {
          ctxAny._i32ElemArrayOverride = prevElemOverride;
        }
        stackType = resultType ?? wasmType;
        if (
          resultType &&
          wasmType.kind === "externref" &&
          (resultType.kind === "ref" || resultType.kind === "ref_null") &&
          !isVar &&
          !(fctx.tdzFlagLocals?.has(name) ?? false) &&
          localIdx >= fctx.params.length
        ) {
          const localSlot = fctx.locals[localIdx - fctx.params.length];
          if (localSlot?.type.kind === "externref") {
            localSlot.type =
              resultType.kind === "ref"
                ? { kind: "ref_null", typeIdx: (resultType as { typeIdx: number }).typeIdx }
                : resultType;
          }
        }
        // Coerce if the expression produced a type that doesn't match the local.
        // (#2692) When boxed, the target is the box's value type — the
        // `boxedForInit` struct.set path below writes the cell; coercing to the
        // box ref type here would corrupt the stack.
        const targetType = boxedForInit ? boxedForInit.valType : (getLocalType(fctx, localIdx) ?? wasmType);
        if (resultType && !valTypesMatch(resultType, targetType)) {
          const bodyLenBeforeCoerce = fctx.body.length;
          coerceType(ctx, fctx, resultType, targetType);
          // Only update stackType if coercion actually emitted instructions.
          // If coerceType was a no-op (e.g. unrelated struct types), keep
          // the original resultType so emitCoercedLocalSet can detect the
          // mismatch and update the local's declared type accordingly.
          if (fctx.body.length > bodyLenBeforeCoerce) {
            stackType = targetType; // after coercion, stack is targetType
          }
        }
      }
      // #1177/#2692: If the variable was boxed BEFORE this declaration ran
      // (a closure constructed earlier, OR #2692 eager function-top boxing),
      // `localIdx` already points to a `ref __ref_cell_T` local and a plain
      // `local.set` would be a type mismatch. Route the assignment through
      // `struct.set` on the ref cell so post-init mutations propagate to every
      // closure that captured the same cell. (The inner-scope `boxedForInit`
      // above made the initializer value/coerce box-aware; re-resolve here for
      // this outer scope.)
      const boxedForInitStore = fctx.boxedCaptures?.get(name);
      if (boxedForInitStore) {
        const boxedForInit = boxedForInitStore;
        // Coerce stack to value type if needed.
        if (!valTypesMatch(stackType, boxedForInit.valType)) {
          coerceType(ctx, fctx, stackType, boxedForInit.valType);
        }
        const tmpVal = allocLocal(fctx, `__box_init_tmp_${fctx.locals.length}`, boxedForInit.valType);
        fctx.body.push({ op: "local.set", index: tmpVal });
        fctx.body.push({ op: "local.get", index: localIdx });
        fctx.body.push({ op: "ref.is_null" });
        fctx.body.push({
          op: "if",
          blockType: { kind: "empty" },
          then: [] as Instr[],
          else: [
            { op: "local.get", index: localIdx } as Instr,
            { op: "local.get", index: tmpVal } as Instr,
            {
              op: "struct.set",
              typeIdx: boxedForInit.refCellTypeIdx,
              fieldIdx: 0,
            } as Instr,
          ],
        });
      } else {
        emitCoercedLocalSet(ctx, fctx, localIdx, stackType);
      }
    } else if (wasmType.kind === "externref") {
      // (#2705) A bare `var x;` redeclaration whose slot was already hoisted to
      // the function scope (and initialized to `undefined` at function entry by
      // `hoistVarDecl`) is a runtime NO-OP per ECMA-262 §14.3.2.1 — re-emitting
      // `__get_undefined` here would CLOBBER any value the variable already
      // holds. Concretely, `for (var x in obj) { var x; … }` writes the
      // enumerated key into x's slot, then the body's `var x;` redeclaration
      // would reset it to undefined. Only emit the undefined-init for a FRESH
      // slot (the genuine first declaration) or a let/const binding leaving the
      // TDZ; skip it for a var that reused a hoisted local.
      const isVarRedeclOfHoistedSlot = isVar && existingIdx !== undefined && existingIdx >= fctx.params.length;
      if (!isVarRedeclOfHoistedSlot) {
        // No initializer: `let x;` / `var x;` — in JS, uninitialized variables
        // are `undefined`, not `null`. Emit __get_undefined() so that
        // `x === undefined` works correctly (#737).
        emitUndefined(ctx, fctx);
        // #1177: If a closure captured x BEFORE this declaration ran, `localIdx`
        // is now the boxed ref-cell ref local. Route the init through
        // `struct.set` on the ref cell so the closure observes the same value.
        // Without this, the post-fixup `local.set` becomes an `any.convert_extern;
        // ref.cast null (ref __ref_cell_T)` that traps at runtime ("illegal cast"),
        // because JS undefined is not a struct ref.
        const boxedNoInit = fctx.boxedCaptures?.get(name);
        if (boxedNoInit) {
          const tmpVal = allocLocal(fctx, `__box_init_tmp_${fctx.locals.length}`, boxedNoInit.valType);
          fctx.body.push({ op: "local.set", index: tmpVal });
          fctx.body.push({ op: "local.get", index: localIdx });
          fctx.body.push({ op: "ref.is_null" });
          fctx.body.push({
            op: "if",
            blockType: { kind: "empty" },
            then: [] as Instr[],
            else: [
              { op: "local.get", index: localIdx } as Instr,
              { op: "local.get", index: tmpVal } as Instr,
              { op: "struct.set", typeIdx: boxedNoInit.refCellTypeIdx, fieldIdx: 0 } as Instr,
            ],
          });
        } else {
          fctx.body.push({ op: "local.set", index: localIdx });
        }
      }
    }
    // Set local TDZ flag to 1 (initialized) if this is a hoisted let/const
    emitLocalTdzInit(fctx, name);

    // (#1672) If compiling this initializer promoted `name` to a captured
    // global (because a method/accessor body in the initializer referenced
    // `name` itself), the store above wrote only the local — but the promotion
    // seeded the global with the STALE pre-assignment value and every later
    // read of `name` now goes through the global. Re-sync the global from the
    // local so subsequent reads observe the freshly-initialized value. We only
    // do this for the promotion-during-this-init case (not pre-existing
    // captured globals, which the normal module-global store path handles).
    const capturedGlobalIdx = ctx.capturedGlobals.get(name);
    if (capturedGlobalIdx !== undefined && !wasCapturedGlobalBefore && localIdx >= fctx.params.length) {
      const localSlot = fctx.locals[localIdx - fctx.params.length];
      const globalSlot = ctx.mod.globals[localGlobalIdx(ctx, capturedGlobalIdx)];
      if (localSlot && globalSlot) {
        fctx.body.push({ op: "local.get", index: localIdx } as Instr);
        // Coerce the local value to the global's declared type if they differ
        // (e.g. local is `(ref N)` while the captured global was widened to
        // `ref_null`/`externref`). Reuse the shared coercion helper.
        if (!valTypesMatch(localSlot.type, globalSlot.type)) {
          coerceType(ctx, fctx, localSlot.type, globalSlot.type);
        }
        fctx.body.push({ op: "global.set", index: capturedGlobalIdx } as Instr);
      }
    }
  }
}
