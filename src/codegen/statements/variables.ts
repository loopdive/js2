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
import { needsTdzFlag, resolveWasmType } from "../index.js";
import { resolveComputedKeyExpression } from "../literals.js";
import { localGlobalIdx } from "../registry/imports.js";
import { getOrRegisterArrayType, getOrRegisterSubviewType, getOrRegisterVecType } from "../registry/types.js";
import { coerceType, compileExpression, valTypesMatch } from "../shared.js";
import { emitGuardedRefCast } from "../type-coercion.js";
import { compileArrayDestructuring, compileObjectDestructuring } from "./destructuring.js";
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

function localTypeForDeclaration(ctx: CodegenContext, type: ts.Type): ValType {
  return isNullablePrimitiveType(type) ? { kind: "externref" } : resolveWasmType(ctx, type);
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

    // Class expression: const C = class { ... } — skip, already handled as class declaration
    if (decl.initializer && ts.isClassExpression(decl.initializer)) {
      continue;
    }

    // For arrow/function expression initializers, compile the expression first
    // to get the actual closure struct ref type (resolveWasmType returns externref
    // for function types, but closures need ref $struct)
    if (decl.initializer && (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))) {
      const actualType = compileExpression(ctx, fctx, decl.initializer);
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
    if (initIsAccessorLiteral) {
      ctx.externrefAccessorVars.add(name);
    }

    const standaloneRegExpMatchArrayType = inferStandaloneRegExpMatchArrayType(ctx, decl.initializer);
    const subarraySubviewType = inferSubarraySubviewType(ctx, fctx, decl.initializer);
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
    const wasmType: ValType = initIsAccessorLiteral
      ? { kind: "externref" as const }
      : isI32CoercedLocal
        ? { kind: "i32" }
        : isI32SpecializedArray
          ? { kind: "ref_null" as const, typeIdx: getOrRegisterVecType(ctx, "i32", { kind: "i32" }) }
          : widenedTypeIdx !== undefined
            ? { kind: "ref_null" as const, typeIdx: widenedTypeIdx }
            : (subarraySubviewType ??
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
                      : localTypeForDeclaration(ctx, varType)));

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
        } else if (standaloneRegExpMatchArrayType !== null && existingIsExternref && newIsRef) {
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
        const initializerExpectedType = getLocalType(fctx, localIdx) ?? wasmType;
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
        // Coerce if the expression produced a type that doesn't match the local
        const targetType = getLocalType(fctx, localIdx) ?? wasmType;
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
      // #1177: If the variable was boxed by a closure constructed BEFORE this
      // declaration ran (e.g. `function() { f(); }` constructed before
      // `let x` is reached), `localIdx` already points to a `ref __ref_cell_T`
      // local and a plain `local.set` would be a type mismatch. Route the
      // assignment through `struct.set` on the ref cell so post-init mutations
      // propagate to every closure that captured the same cell.
      const boxedForInit = fctx.boxedCaptures?.get(name);
      if (boxedForInit) {
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
