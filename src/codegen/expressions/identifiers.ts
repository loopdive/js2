// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Identifier resolution, TDZ analysis, and instanceof handling.
 */
import { ts, forEachChild } from "../../ts-api.js";
import {
  getNullablePrimitiveInfo,
  isBigIntType,
  isBooleanType,
  isDeclaredHeterogeneousPrimitiveUnion,
  isHeterogeneousUnion,
  isNumberType,
  isStringType,
  type NullablePrimitiveInfo,
  type NullablePrimitiveKind,
} from "../../checker/type-mapper.js";
import type { Instr, ValType } from "../../ir/types.js";
import { emitCachedFuncClosureAccess, emitFuncRefAsClosure } from "../closures.js";
import { materializeHoistedFunctionValueBinding } from "../closures/funcref-as-closure.js";
import { emitNativeGlobalThisObject } from "../array-object-proto.js";
import { tryEmitNativeUserCtorInstanceOf } from "../native-user-instanceof.js";
import { emitLazyClassObjectGet } from "./extern.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import {
  addFuncType,
  addImport,
  addStringConstantGlobal,
  addUnionImports,
  ensureExnTag,
  localGlobalIdx,
  resolveWasmType,
} from "../index.js";
import { emitCapturedBoxGlobalRead, emitNullGuardedStructGet, getCapturedBoxGlobal } from "../property-access.js";
import { coerceType, compileExpression, isAnyValue } from "../shared.js";
import { emitTdzCheck } from "../statements.js";
import { emitUndefined, ensureLateImport, flushLateImportShifts, shiftLateImportIndices } from "./late-imports.js";
import { emitStringBuilderRead, getBuilderInfo } from "../string-builder.js";
import { stringConstantExternrefInstrs } from "../native-strings.js";
import { BUILTIN_TYPE_TAGS, isBuiltinSubtype, isBuiltinTypeName } from "../builtin-tags.js";
import { ensureDateStruct } from "./builtins.js"; // (#1325) native $__Date struct for host-free `instanceof Date`
import { ensureStandaloneRegExpStruct } from "../regexp-standalone.js"; // (#1325) native RegExp struct for host-free `instanceof RegExp`
import { getOrRegisterPromiseType } from "../async-scheduler.js"; // (#1325) native $Promise struct for host-free `instanceof Promise`
import { getOrRegisterErrorStructType, isWasiErrorName } from "../registry/error-types.js";
import { allocLocal } from "../context/locals.js";
import { popBody, pushBody } from "../context/bodies.js";
import { reportSilentFallback } from "../fallback-telemetry.js";
import { reportError } from "../context/errors.js";
import { isUnaliasedNodeFsImportBinding } from "../node-fs-binding-identity.js";
import { annexBReadEscapesFunctionScope, annexBReadIsUnbound, collectAnnexBCancelSites } from "../annexb-cancel.js";
import { emitAnnexBUnboundReferenceError } from "../js-errors.js";
import {
  identifierIsWrittenTo,
  resolveBuiltinCtorAliasName,
  tryEmitNonCallableRhsThrow,
} from "../native-ordinary-instanceof.js";
import { tryEmitNativeDynamicInstanceOf } from "../native-dynamic-instanceof.js";
import { isObjectFamilyCtorName, tryEmitNativeObjectFamilyInstanceOf } from "../native-object-family-instanceof.js";
import { emitTaCtorValue } from "../dataview-native.js";
import { taCtorKindOf } from "../registry/types.js";
import { emitThrowReferenceError, emitThrowTypeError, noJsHost } from "./helpers.js";
import { emitDynamicWithGet, emitWithBindingGet, resolveWithBinding } from "../with-scope.js";
import {
  emitBuiltinConstructorIdentity,
  emitBuiltinNamespaceObject,
  isBuiltinConstructorIdentityName,
  isSupportedBuiltinNamespace,
} from "../builtin-static-globals.js";
import { tryEmitPromiseSubclassValue } from "./promise-subclass.js";
import {
  emitCaptureRuntimeEvalBindingValueCell,
  emitImplicitGlobalRead,
  emitRuntimeEvalBindingRead,
  emitRuntimeEvalGlobalRead,
  emitRuntimeEvalSharedValueUnwrap,
  runtimeEvalSharedValueUnwrapInstrs,
} from "../global-environment.js";
import { runtimeEvalStateMayShadowBinding } from "../direct-eval-environment.js";
import { emitStandaloneIntrinsicEvalValue } from "./eval-inline.js";
import { emitStandaloneFunctionIntrinsicValue } from "../function-intrinsic-carrier.js"; // (#4442) THE `%Function%` emitter
import { definedFuncAt } from "../func-space.js";
import { emitHostOrNativeBuiltinInstanceOf } from "../host-native-instanceof.js";
import {
  ensureStandaloneWrapperInstanceOfHelper,
  type StandaloneWrapperConstructorName,
} from "../standalone-wrapper-instanceof.js";
import { tryEmitStandaloneGlobalFunctionIdentifier } from "../standalone-global-functions.js";

/**
 * #1473 — Build the set of `$Error_struct` `$tag` values compatible with an
 * `instanceof <ctorName>` test in no-JS-host mode. For `instanceof Error` this
 * is every Error subtype tag; for `instanceof TypeError` it is TypeError's own
 * tag plus any descendant (none today). Mirrors `isBuiltinSubtype` over the
 * error portion of the BUILTIN_TYPE_TAGS registry.
 */
function collectErrorInstanceOfTags(ctorName: string): number[] {
  const errorNames = [
    "Error",
    "TypeError",
    "RangeError",
    "SyntaxError",
    "URIError",
    "EvalError",
    "ReferenceError",
    "AggregateError",
    // (#3234) SuppressedError is an Error subclass (BUILTIN_PARENT). Included so
    // `instanceof SuppressedError` matches its own tag, and `instanceof Error`
    // also matches a native SuppressedError (built by the dispose driver).
    "SuppressedError",
  ] as const;
  const tags: number[] = [];
  for (const n of errorNames) {
    if (isBuiltinSubtype(n, ctorName)) {
      tags.push(BUILTIN_TYPE_TAGS[n]);
    }
  }
  return tags;
}

/**
 * (#2188) Build the set of per-class brand ids (`classTagMap` values) that count
 * as `instanceof <ctorName>` for a standalone-native user Error subclass, where
 * `ctorName` is itself a user subclass of a builtin Error. The set is `ctorName`'s
 * own id plus every user class that transitively extends `ctorName` (so an
 * instance of `class C extends A {}` matches `instanceof A`). Sibling subclasses
 * are excluded — that is the precision the brand restores (#2188): `(new A)` is
 * branded with A's id, which is NOT in `B`'s id set, so `(new A) instanceof B`
 * is false. Builtin parents (`Error`/`TypeError`) keep the field-0 tag check and
 * never call this. Returns brand ids; empty only if `ctorName` is unregistered.
 */
function collectUserErrorSubclassBrandIds(ctx: CodegenContext, ctorName: string): number[] {
  const ids: number[] = [];
  const ownId = ctx.classTagMap.get(ctorName);
  if (ownId !== undefined) ids.push(ownId);
  // Every user class whose ancestor chain (via classParentMap) reaches ctorName
  // is a descendant subclass — include its brand. Walk each registered class's
  // parent chain rather than maintaining a children index.
  for (const [cls, id] of ctx.classTagMap) {
    if (cls === ctorName) continue;
    let cursor: string | undefined = ctx.classParentMap.get(cls);
    const seen = new Set<string>();
    while (cursor !== undefined && !seen.has(cursor)) {
      seen.add(cursor);
      if (cursor === ctorName) {
        ids.push(id);
        break;
      }
      cursor = ctx.classParentMap.get(cursor);
    }
  }
  return ids;
}

export function emitLocalTdzCheck(ctx: CodegenContext, fctx: FunctionContext, name: string, flagIdx: number): void {
  const msg = `${name} is not defined`;
  // #1473 — no JS host: build the TDZ flag check and emit a ReferenceError
  // INSTANCE throw inside the `then` branch via the in-module constructor
  // helper (no `__throw_reference_error` host import).
  if (noJsHost(ctx)) {
    const boxed = fctx.boxedTdzFlags?.get(name);
    if (boxed) {
      fctx.body.push({ op: "local.get", index: boxed.localIdx });
      fctx.body.push({ op: "struct.get", typeIdx: boxed.refCellTypeIdx, fieldIdx: 0 });
    } else {
      fctx.body.push({ op: "local.get", index: flagIdx });
    }
    fctx.body.push({ op: "i32.eqz" });
    // emitThrowReferenceError appends to fctx.body; capture into the `then`
    // branch by swapping in a temporary body (tracked in savedBodies so any
    // late-import index shift reaches it).
    const savedBody = fctx.body;
    fctx.savedBodies.push(savedBody);
    fctx.body = [];
    emitThrowReferenceError(ctx, fctx, msg);
    fctx.body.push({ op: "unreachable" });
    const then = fctx.body;
    const si = fctx.savedBodies.lastIndexOf(savedBody);
    if (si >= 0) fctx.savedBodies.splice(si, 1);
    fctx.body = savedBody;
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then,
      else: [],
    });
    return;
  }
  const throwRefErrIdx = ensureLateImport(ctx, "__throw_reference_error", [{ kind: "externref" }], []);
  flushLateImportShifts(ctx, fctx);
  // If the flag has been boxed in an i32 ref cell (captured by a closure —
  // see #1177), read it through `struct.get` so we observe mutations the
  // outer scope made via the same ref cell.
  const boxed = fctx.boxedTdzFlags?.get(name);
  if (boxed) {
    fctx.body.push({ op: "local.get", index: boxed.localIdx });
    fctx.body.push({ op: "struct.get", typeIdx: boxed.refCellTypeIdx, fieldIdx: 0 });
  } else {
    fctx.body.push({ op: "local.get", index: flagIdx });
  }
  fctx.body.push({ op: "i32.eqz" });
  let then: Instr[];
  if (throwRefErrIdx !== undefined) {
    addStringConstantGlobal(ctx, msg);
    const strIdx = ctx.stringGlobalMap.get(msg)!;
    then = [{ op: "global.get", index: strIdx }, { op: "call", funcIdx: throwRefErrIdx }, { op: "unreachable" }];
  } else {
    const tagIdx = ensureExnTag(ctx);
    then = [{ op: "ref.null.extern" }, { op: "throw", tagIdx }];
  }
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then,
    else: [],
  });
}

/** Resolve the lexical value read by an identifier, including `{ value }`. */
function identifierValueSymbol(ctx: CodegenContext, id: ts.Identifier): ts.Symbol | undefined {
  if (ts.isShorthandPropertyAssignment(id.parent) && id.parent.name === id) {
    const shorthand = (
      ctx.checker as typeof ctx.checker & {
        getShorthandAssignmentValueSymbol?: (node: ts.ShorthandPropertyAssignment) => ts.Symbol | undefined;
      }
    ).getShorthandAssignmentValueSymbol?.(id.parent);
    if (shorthand !== undefined) return shorthand;
  }
  return ctx.checker.getSymbolAtLocation(id);
}

/**
 * Static TDZ analysis: determine at compile time whether a let/const variable
 * access is guaranteed to be after initialization (safe) or before (TDZ violation).
 *
 * Returns:
 * - 'skip': access is after declaration in straight-line code — no check needed
 * - 'throw': access is before declaration in straight-line code — guaranteed TDZ error
 * - 'check': can't determine statically — keep runtime flag check
 */
function analyzeTdzAccess(ctx: CodegenContext, id: ts.Identifier): "skip" | "throw" | "check" {
  // A shorthand property name (`{ value }`) has two symbols in TypeScript:
  // the property being declared and the lexical binding whose value is read.
  // `getSymbolAtLocation(id)` answers the former, whose declaration range is
  // the shorthand itself. Treating that property declaration as the lexical
  // declaration makes every tracked shorthand look like a self-read in its
  // own TDZ and emits an unconditional ReferenceError. Ask the checker for the
  // value symbol so ordering is measured against the real let/const binding.
  const symbol = identifierValueSymbol(ctx, id);
  if (!symbol) return "check";
  const decl = symbol.valueDeclaration;
  if (!decl) return "check";

  const accessPos = id.getStart();
  const declEnd = decl.getEnd(); // use end of declaration (after initializer)

  // Find the containing function of the access and the declaration.
  const accessFunc = getContainingFunction(id);
  const declFunc = getContainingFunction(decl);

  if (accessFunc !== declFunc) {
    // Access is in a nested closure. We can still prove it safe if:
    // 1. The closure is an arrow function or function expression (not hoisted), AND
    // 2. The closure definition starts after the variable's declaration ends, AND
    // 3. No loop wraps both the declaration and the closure definition
    // In that case, the closure cannot exist until after the variable is initialized,
    // so any invocation of the closure is guaranteed to see the initialized value.
    if (accessFunc && !ts.isFunctionDeclaration(accessFunc) && !ts.isSourceFile(accessFunc)) {
      const closureStart = accessFunc.getStart();
      if (closureStart >= declEnd && !isInsideLoopContaining(accessFunc as ts.Node, decl)) {
        return "skip";
      }
    }
    return "check";
  }

  // Check if the access is inside a loop that contains the declaration
  // (back-edge could reach access before re-initialization)
  if (isInsideLoopContaining(id, decl)) return "check";

  if (accessPos >= declEnd) {
    // Access is after the full declaration (including initializer) — safe
    return "skip";
  } else {
    // Access is before declaration — guaranteed TDZ violation
    // But only if not in a loop that wraps both (already checked above)
    return "throw";
  }
}

/** Walk up to find the nearest containing function (or source file for top-level). */
function getContainingFunction(node: ts.Node): ts.Node | undefined {
  let current = node.parent;
  while (current) {
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current) ||
      ts.isMethodDeclaration(current) ||
      ts.isConstructorDeclaration(current) ||
      ts.isGetAccessorDeclaration(current) ||
      ts.isSetAccessorDeclaration(current) ||
      ts.isSourceFile(current)
    ) {
      return current;
    }
    current = current.parent;
  }
  return undefined;
}

/**
 * Check if the access node is inside a loop body that also contains (or is
 * an ancestor of) the declaration. In that case the access could run on a
 * subsequent iteration before the declaration re-initializes the variable.
 *
 * Exception: if the declaration is inside the loop body (not the for-initializer)
 * and the access is textually after the declaration, the back-edge is harmless
 * because let/const creates a fresh binding each iteration.
 */
function isInsideLoopContaining(access: ts.Node, decl: ts.Node): boolean {
  let current = access.parent;
  while (current) {
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current) ||
      ts.isMethodDeclaration(current) ||
      ts.isSourceFile(current)
    ) {
      // Reached function boundary without finding a loop
      return false;
    }
    if (isLoopStatement(current)) {
      // Check if the declaration is also inside this loop
      if (isDescendantOf(decl, current)) {
        // Both are inside this loop. If the decl is in the loop body
        // (not the for-initializer/condition/incrementor) and the access
        // is textually after the decl, the per-iteration fresh binding
        // guarantees initialization before access on every iteration.
        const body = getLoopBody(current);
        if (body && isDescendantOf(decl, body) && access.getStart() >= decl.getEnd()) {
          // Safe: loop-local let/const, access after declaration in same iteration
          return false;
        }
        return true;
      }
    }
    current = current.parent;
  }
  return false;
}

/** Get the body statement/block of a loop node. */
function getLoopBody(loop: ts.Node): ts.Node | undefined {
  if (ts.isForStatement(loop)) return loop.statement;
  if (ts.isForInStatement(loop)) return loop.statement;
  if (ts.isForOfStatement(loop)) return loop.statement;
  if (ts.isWhileStatement(loop)) return loop.statement;
  if (ts.isDoStatement(loop)) return loop.statement;
  return undefined;
}

function isLoopStatement(node: ts.Node): boolean {
  return (
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node)
  );
}

function isDescendantOf(node: ts.Node, ancestor: ts.Node): boolean {
  let current: ts.Node | undefined = node;
  while (current) {
    if (current === ancestor) return true;
    current = current.parent;
  }
  return false;
}

function getDeclaredNullablePrimitiveInfo(ctx: CodegenContext, id: ts.Identifier): NullablePrimitiveInfo | null {
  const symbol = identifierValueSymbol(ctx, id);
  const decl = symbol?.valueDeclaration;
  if (!decl) return null;
  if (ts.isVariableDeclaration(decl) || ts.isParameter(decl)) {
    return getNullablePrimitiveInfo(ctx.checker.getTypeAtLocation(decl));
  }
  return null;
}

function emitNullablePrimitiveUnbox(
  ctx: CodegenContext,
  fctx: FunctionContext,
  primitiveKind: NullablePrimitiveKind,
): ValType | null {
  if (primitiveKind === "string") return null;
  addUnionImports(ctx);
  if (primitiveKind === "number") {
    const funcIdx = ctx.funcMap.get("__unbox_number");
    if (funcIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx });
      return { kind: "f64" };
    }
  }
  if (primitiveKind === "boolean") {
    const funcIdx = ctx.funcMap.get("__unbox_boolean");
    if (funcIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx });
      return { kind: "i32" };
    }
  }
  if (primitiveKind === "bigint") {
    const funcIdx = ctx.funcMap.get("__to_bigint");
    if (funcIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx });
      return { kind: "i64", bigint: true };
    }
  }
  return null;
}

/**
 * Compile-time TDZ elision for top-level let/const variables (#906).
 *
 * Returns the subset of `candidates` for which TDZ tracking can be statically
 * compiled away — i.e. every identifier reference in the source file that
 * resolves to the candidate's declaration is provably after initialization
 * (analyzeTdzAccess returns "skip"). For these names, the caller can skip
 * emitting the `__tdz_<name>` global, the `global.set __tdz_<name>` writes
 * in the module init body, and the runtime check at every read.
 *
 * If a candidate has *any* reference that yields "throw" or "check", it stays
 * tracked at runtime. This preserves observable semantics for genuinely
 * dynamic or ambiguous cases (e.g. a function declaration that reads the
 * variable, since hoisted functions could be called before the variable's
 * initializer runs).
 */
export function computeElidableTopLevelTdzNames(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile,
  candidates: Set<string>,
): Set<string> {
  if (candidates.size === 0) return new Set();

  // Build name → declaration map for top-level let/const candidates so we can
  // verify that an Identifier resolves to OUR declaration (and not a shadowed
  // local or unrelated symbol with the same name).
  const declByName = new Map<string, ts.VariableDeclaration>();
  for (const stmt of sourceFile.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    const isLetOrConst = (stmt.declarationList.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) !== 0;
    if (!isLetOrConst) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (ts.isIdentifier(decl.name) && candidates.has(decl.name.text)) {
        declByName.set(decl.name.text, decl);
      }
    }
  }
  if (declByName.size === 0) return new Set();

  const elidable = new Set(declByName.keys());

  function walk(node: ts.Node): void {
    if (elidable.size === 0) return;
    if (ts.isIdentifier(node) && elidable.has(node.text)) {
      // Skip the identifier of the declaration itself.
      const isDeclName = ts.isVariableDeclaration(node.parent) && node.parent.name === node;
      if (!isDeclName) {
        // Verify this identifier resolves to OUR top-level declaration
        // (and not a shadowed local with the same name).
        const symbol = ctx.checker.getSymbolAtLocation(node);
        const decl = symbol?.valueDeclaration;
        if (decl === declByName.get(node.text)) {
          const result = analyzeTdzAccess(ctx, node);
          if (result !== "skip") {
            elidable.delete(node.text);
          }
        }
      }
    }
    forEachChild(node, walk);
  }
  walk(sourceFile);

  return elidable;
}

/**
 * Position-based TDZ analysis for call-site capture checks.
 * Used when we know the variable name and the call expression position,
 * but don't have an identifier with a resolved symbol (e.g., pushing
 * closure captures at a nested function call site).
 */
function analyzeTdzAccessByPos(ctx: CodegenContext, varName: string, callNode: ts.Node): "skip" | "throw" | "check" {
  // Look up the variable's symbol via the checker
  // We need to find the declaration to get its end position
  const sourceFile = callNode.getSourceFile();
  if (!sourceFile) return "check";

  // Find the declaration by looking up the local symbol in scope
  const sym = ctx.checker.getSymbolsInScope(callNode, ts.SymbolFlags.Variable).find((s) => s.name === varName);
  if (!sym) return "check";
  const decl = sym.valueDeclaration;
  if (!decl) return "check";

  const callPos = callNode.getStart();
  const declEnd = decl.getEnd();

  // Both must be in the same function scope (call site is in the declaring function)
  const callFunc = getContainingFunction(callNode);
  const declFunc = getContainingFunction(decl);
  if (callFunc !== declFunc) return "check";

  if (isInsideLoopContaining(callNode, decl)) return "check";

  if (callPos >= declEnd) {
    return "skip";
  } else {
    return "throw";
  }
}

/** Emit a static TDZ throw (guaranteed violation — no flag check needed). */
export function emitStaticTdzThrow(ctx: CodegenContext, fctx: FunctionContext, name: string): void {
  const msg = `${name} is not defined`;
  // #1473 — no JS host: throw a ReferenceError INSTANCE built in-module.
  if (noJsHost(ctx)) {
    emitThrowReferenceError(ctx, fctx, msg);
    fctx.body.push({ op: "unreachable" });
    return;
  }
  const throwRefErrIdx = ensureLateImport(ctx, "__throw_reference_error", [{ kind: "externref" }], []);
  flushLateImportShifts(ctx, fctx);
  if (throwRefErrIdx !== undefined) {
    addStringConstantGlobal(ctx, msg);
    const strIdx = ctx.stringGlobalMap.get(msg)!;
    fctx.body.push({ op: "global.get", index: strIdx });
    fctx.body.push({ op: "call", funcIdx: throwRefErrIdx });
    fctx.body.push({ op: "unreachable" });
    return;
  }
  const tagIdx = ensureExnTag(ctx);
  fctx.body.push({ op: "ref.null.extern" });
  fctx.body.push({ op: "throw", tagIdx });
}

function compileIdentifier(ctx: CodegenContext, fctx: FunctionContext, id: ts.Identifier): ValType | null {
  const name = id.text;

  // (#1387 / #2663) `with` scope resolution, innermost-first.
  const withRes = resolveWithBinding(fctx, name);
  if (withRes?.kind === "static") {
    return emitWithBindingGet(fctx, withRes.binding);
  }
  if (withRes?.kind === "dynamic") {
    // (#2663 Slice 1) HasBinding-gated runtime read. The HasBinding-miss fallback
    // must re-resolve against the OUTER scopes (a name absent on the inner `with`
    // object cascades to the next-outer `with`, then to the lexical binding —
    // §nested-with). Temporarily truncate `withScopes` to exclude the matched
    // scope (and anything inner to it), re-run full identifier resolution for the
    // else arm, then restore the stack.
    const scopes = fctx.withScopes!;
    const matchedIdx = scopes.lastIndexOf(withRes.scope);
    return emitDynamicWithGet(ctx, fctx, withRes.scope, name, () => {
      const saved = fctx.withScopes;
      fctx.withScopes = scopes.slice(0, matchedIdx);
      try {
        return compileIdentifier(ctx, fctx, id);
      } finally {
        fctx.withScopes = saved;
      }
    });
  }

  return compileIdentifierCore(ctx, fctx, id);
}

/** The non-`with` identifier lowering (locals, globals, funcs, builders,
 *  ReferenceError). Split out so the Tier-2 dynamic `with` path can invoke it as
 *  the HasBinding-miss fallback (#2663 Slice 1). */
function compileIdentifierCore(
  ctx: CodegenContext,
  fctx: FunctionContext,
  id: ts.Identifier,
  skipRuntimeEvalState = false,
): ValType | null {
  const name = id.text;

  // #1210: string-builder bindings are stored as a (buf, len, cap, mat)
  // tuple of synthetic locals. The binding name is intentionally NOT in
  // `localMap` — read access materializes a NativeString lazily and caches
  // it in `mat`. Check this before the normal local lookup.
  const sb = getBuilderInfo(fctx, name);
  if (sb !== undefined) {
    return emitStringBuilderRead(ctx, fctx, sb);
  }

  // A sloppy direct eval can create a var binding in this activation after an
  // earlier source-position read was compiled, and that binding shadows an
  // outer capture or ambient/global symbol. Compile the ordinary resolution as
  // the miss arm, then select through the stable caller-owned value cell. A
  // current-function local/lexical binding is excluded by the shared predicate.
  if (!skipRuntimeEvalState && runtimeEvalStateMayShadowBinding(ctx, fctx, name)) {
    const savedFallback = pushBody(fctx);
    const fallbackType = compileIdentifierCore(ctx, fctx, id, true);
    if (fallbackType === null) {
      popBody(fctx, savedFallback);
      return null;
    }
    if (fallbackType.kind !== "externref") coerceType(ctx, fctx, fallbackType, { kind: "externref" });
    const fallbackBody = fctx.body;
    popBody(fctx, savedFallback);

    const captured = emitCaptureRuntimeEvalBindingValueCell(ctx, fctx, name);
    if (!captured) {
      fctx.body.push(...fallbackBody);
      return { kind: "externref" };
    }
    const presentBody: Instr[] = [
      { op: "local.get", index: captured.valueCellLocal },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: captured.cellTypeIdx },
      { op: "struct.get", typeIdx: captured.cellTypeIdx, fieldIdx: 0 },
      ...runtimeEvalSharedValueUnwrapInstrs(ctx, fctx),
    ];
    fctx.body.push(
      { op: "local.get", index: captured.valueCellLocal },
      { op: "ref.is_null" },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "externref" } },
        then: presentBody,
        else: fallbackBody,
      },
    );
    return { kind: "externref" };
  }

  // (#2200 Phase 1, Annex B B.3.3) If `name` is a block-nested function whose
  // web-compat outer var-binding was cancelled (intervening lexical shadow /
  // same-named param — recorded in `fctx.annexBCancelled` during hoisting), a
  // read OUTSIDE the declaring block has no binding and must throw
  // ReferenceError — even though the funcMap (and the TS checker's Annex-B-hoisted
  // symbol) still resolve the name, and even though the compiler's flat
  // `localMap` may carry a shared slot for the like-named lexical. A read INSIDE
  // the declaring block falls through to normal resolution (the block-local
  // function / lexical). Checked BEFORE localMap so the cancellation wins; gated
  // on the normally-empty `annexBCancelled` set, so non-Annex-B modules are
  // byte-identical.
  const cancelRanges = fctx.annexBCancelled?.get(name);
  if (cancelRanges && cancelRanges.length > 0) {
    const pos = id.getStart();
    const insideDeclaringBlock = cancelRanges.some((r) => pos >= r.start && pos < r.end);
    if (!insideDeclaringBlock) return emitAnnexBUnboundReferenceError(ctx, fctx, name);
  }

  // (#3980, Annex B B.3.3) The `fctx.annexBCancelled` map above is per-
  // FunctionContext, so it is invisible inside NESTED function bodies — yet that
  // is exactly where the 96 `annexB/language/*-skip-early-err-*` reads live
  // (`assert.throws(ReferenceError, function () { f; })`). It also only sees a
  // `function` whose direct parent is a `Block` shadowed by a sibling `let`.
  // `collectAnnexBCancelSites` is the position-based, whole-SourceFile
  // counterpart: it covers the `if`-clause and `switch` case/default declaration
  // positions plus lexical loop heads and destructuring `catch` parameters, and
  // it answers for a read ANYWHERE in the module. Memoized per SourceFile and
  // short-circuiting on the (near-universally) empty site list, so non-Annex-B
  // modules are byte-identical.
  const annexBSites = collectAnnexBCancelSites(id.getSourceFile());
  if (annexBSites.length > 0 && annexBReadIsUnbound(annexBSites, id)) {
    return emitAnnexBUnboundReferenceError(ctx, fctx, name);
  }
  if (annexBReadEscapesFunctionScope(id)) {
    return emitAnnexBUnboundReferenceError(ctx, fctx, name);
  }

  // (#2552 Phase 2) A bare value READ of an Annex B B.3.3 block-nested function
  // whose web-compat outer var-binding is pre-allocated (an externref local + a
  // TDZ flag). Unlike a let/const TDZ binding, the outer binding is `var`-style:
  // it EXISTS before the block runs, just uninitialised — so a read before/when
  // the block is skipped yields `undefined`, NOT a ReferenceError. The generic
  // localMap path below would instead apply the shared `tdzFlagLocals` let/const
  // throw semantics (a textually-before read → emitStaticTdzThrow → "f is not
  // defined"), which is wrong for Annex B. Intercept here with a flag-gated read:
  // flag 1 ⇒ the outer-binding value, flag 0 ⇒ `undefined`. Gated on the
  // normally-empty `annexBOuterBindings` set so every other read is byte-identical.
  if (fctx.annexBOuterBindings?.has(name)) {
    const outerLocal = fctx.localMap.get(name);
    const flagLocal = fctx.tdzFlagLocals?.get(name);
    if (outerLocal !== undefined && flagLocal !== undefined) {
      // Materialise `undefined` into the MAIN body first (so any late-import
      // shift from ensureGetUndefined lands in the main stream, not inside an
      // if-arm), stash it in a temp, then select on the flag.
      emitUndefined(ctx, fctx);
      const undefLocal = allocLocal(fctx, `__annexb_undef_${fctx.locals.length}`, { kind: "externref" });
      fctx.body.push({ op: "local.set", index: undefLocal });
      fctx.body.push({ op: "local.get", index: flagLocal });
      fctx.body.push({
        op: "if",
        blockType: { kind: "val", type: { kind: "externref" } },
        then: [{ op: "local.get", index: outerLocal }],
        else: [{ op: "local.get", index: undefLocal }],
      });
      return { kind: "externref" };
    }
  }

  const localIdx = fctx.localMap.get(name);
  if (localIdx !== undefined) {
    materializeHoistedFunctionValueBinding(ctx, fctx, name);
    const tdzFlagIdx = fctx.tdzFlagLocals?.get(name);
    if (tdzFlagIdx !== undefined) {
      const tdzResult = analyzeTdzAccess(ctx, id);
      if (tdzResult === "check") {
        emitLocalTdzCheck(ctx, fctx, name, tdzFlagIdx);
      } else if (tdzResult === "throw") {
        emitStaticTdzThrow(ctx, fctx, id.text);
      }
      // tdzResult === "skip" — no check needed, variable is guaranteed initialized
    }

    // Check if this is a boxed (ref cell) mutable capture
    const boxed = fctx.boxedCaptures?.get(name);
    if (boxed) {
      // Read through ref cell: local.get → null guard → struct.get $ref_cell 0
      // The ref cell local is ref_null — if the closure capture is uninitialized,
      // the local is null and struct.get would trap (#702).
      fctx.body.push({ op: "local.get", index: localIdx });
      emitNullGuardedStructGet(
        ctx,
        fctx,
        { kind: "ref_null", typeIdx: boxed.refCellTypeIdx },
        boxed.valType,
        boxed.refCellTypeIdx,
        0,
        undefined /* propName */,
        false /* throwOnNull — ref cells use default for uninitialized captures */,
      );
      // Direct-eval cells cross a separately compiled provider module. Values
      // written by that provider use the canonical `$RuntimeEvalValue`
      // carrier; rebuild the caller module's primitive box before ordinary AOT
      // consumers narrow or unbox it. Other closure-capture cells retain their
      // existing representation and byte shape.
      if (
        boxed.valType.kind === "externref" &&
        boxed.refCellTypeIdx === fctx.directEvalRefCellTypeIdx &&
        ctx.runtimeEvalGlobalFunctionBindings === true
      ) {
        emitRuntimeEvalSharedValueUnwrap(ctx, fctx);
      }
      return boxed.valType;
    }

    fctx.body.push({ op: "local.get", index: localIdx });
    // Determine declared type from params or locals
    let declaredType: ValType;
    if (localIdx < fctx.params.length) {
      declaredType = fctx.params[localIdx]!.type;
    } else {
      const localDef = fctx.locals[localIdx - fctx.params.length];
      declaredType = localDef?.type ?? { kind: "f64" };
    }

    // Narrowing: if the declared type is externref (boxed union) but the
    // checker narrows it to a concrete type, emit an unbox call.
    // (#3315) EXCEPT for undefined-widened parameter-destructured bindings:
    // their checker type is the pattern default's fiction (`number` for
    // `{ w: [x, y, z] = [4, 5, 6] }`), and unboxing here would degrade a
    // runtime `undefined` to NaN before `=== undefined` / any-param uses can
    // observe it. Return the raw externref; numeric consumers coerce at
    // their own use site (ToNumber(undefined) = NaN matches JS).
    if (
      declaredType.kind === "externref" &&
      !fctx.captureExternrefNames?.has(name) &&
      !fctx.undefWidenedLocals?.has(name) &&
      !fctx.forInIdentifierVars?.has(name) &&
      !fctx.mixedAssignmentCarrierVars?.has(name)
    ) {
      const narrowedType = ctx.checker.getTypeAtLocation(id);
      const narrowed = narrowTypeToUnbox(ctx, fctx, narrowedType);
      if (narrowed) return narrowed;
      if (fctx.narrowedNonNull?.has(name)) {
        const declaredNullable = getDeclaredNullablePrimitiveInfo(ctx, id);
        if (declaredNullable) {
          const unboxed = emitNullablePrimitiveUnbox(ctx, fctx, declaredNullable.primitiveKind);
          if (unboxed) return unboxed;
        }
      }
    }

    // (#745 S4, flag-gated) The SAME narrowing hook for the `$AnyValue` union
    // carrier: a heterogeneous-primitive-union local/param narrowed to a
    // single kind at the use site unboxes AT THE READ, so downstream typed
    // consumers (string `.length`/methods, arithmetic, call arguments) see
    // the concrete rep instead of the carrier struct — the untyped read of a
    // union PARAM previously reached string property access as a raw
    // `$AnyValue` and emitted an invalid `struct.get` (the S4 callBoundary
    // row). Oracle-classified (no raw-checker type query); the declared-union
    // gate keeps `any`-typed $AnyValue locals (fast lane) on their existing
    // read path. `typeof x` guard operands stay un-narrowed at their own use
    // site, so the tag-dispatch reads are unaffected.
    if (
      ctx.unionAnyRep &&
      (declaredType.kind === "ref_null" || declaredType.kind === "ref") &&
      isAnyValue(declaredType, ctx) &&
      isDeclaredHeterogeneousPrimitiveUnion(ctx.checker, id)
    ) {
      // All three arms route through the single coercion engine (#2108 drift
      // gate): its $AnyValue→f64 arm is the tag-complete inline unbox
      // (undefined→NaN, boolean→i32val), $AnyValue→i32 reads the i32val
      // payload (tags 2/4), and the string arm is the S3-fixed externval
      // extraction. No hand-rolled helper-call vocabulary here.
      const fact = ctx.oracle.typeFactOf(id);
      if (fact.kind === "number") {
        coerceType(ctx, fctx, declaredType, { kind: "f64" });
        return { kind: "f64" };
      }
      if (fact.kind === "string" && ctx.nativeStrings && ctx.anyStrTypeIdx >= 0) {
        coerceType(ctx, fctx, declaredType, { kind: "ref_null", typeIdx: ctx.anyStrTypeIdx });
        return { kind: "ref_null", typeIdx: ctx.anyStrTypeIdx };
      }
      if (fact.kind === "boolean") {
        coerceType(ctx, fctx, declaredType, { kind: "i32" });
        return { kind: "i32", boolean: true };
      }
    }

    // Null narrowing: if this variable is known non-null (e.g. inside `if (x !== null)`),
    // emit ref.as_non_null and return ref instead of ref_null to skip downstream null guards.
    if (declaredType.kind === "ref_null" && fctx.narrowedNonNull?.has(name)) {
      fctx.body.push({ op: "ref.as_non_null" });
      return { kind: "ref", typeIdx: (declaredType as any).typeIdx };
    }

    return declaredType;
  }

  // (#3045) Lexical class-name binding — a class body evaluates in a dedicated
  // class scope whose sole binding is the class's own name (ES2015 §14.6.13
  // ClassDefinitionEvaluation steps 3–5 & §13.2.1: `classBinding` is bound in
  // `classScope`, immutable, and shadows any outer binding of that name). So in
  //   let C = 'outside'; var cls = class C { method() { return C; } };
  // the `C` inside `method` denotes the CLASS, not the outer `C`. Without this,
  // the read falls to the captured/module-global branches below and returns the
  // outer shadow (`'outside'`), so `cls.prototype.method() === cls` was false
  // (a −2 regression surfaced by #2719 once the binding itself materialized to
  // the canonical singleton). Resolve the enclosing class's own inner name to
  // its canonical `__class_<Name>` singleton — the SAME object the binding read,
  // `instance.constructor`, and `C.staticProp` resolve to — placed AFTER
  // `localMap` (a genuine method-local `C` still shadows the class name) but
  // BEFORE the captured/module-global branches (so the class name wins over an
  // outer same-named binding, per spec). Canonicalize through `classExprNameMap`
  // so both dual-registration names (#1394) collapse to one singleton.
  if (fctx.enclosingClassName !== undefined) {
    const innerEsName = ctx.functionNameMap.get(fctx.enclosingClassName);
    if (innerEsName !== undefined && innerEsName === name && !fctx.localMap.has(name)) {
      const canonicalClassName = ctx.classExprNameMap.get(name) ?? fctx.enclosingClassName;
      if (ctx.classObjectGlobals?.has(canonicalClassName)) {
        if (emitLazyClassObjectGet(ctx, fctx, canonicalClassName)) {
          return { kind: "externref" };
        }
      }
    }
  }

  // (#3039) Check BOXED captured globals FIRST — a transitively-captured
  // mutable var (ref cell) that a method-shorthand / class-method / accessor
  // body reads. The promoted global holds the box; deref it (global.get;
  // struct.get field 0) rather than returning the ref cell as if it were the
  // value (which coerced ref→f64 to `f64.const 0` / ref→externref to garbage).
  const capturedBox = getCapturedBoxGlobal(ctx, name);
  if (capturedBox !== undefined) {
    const tdzResult = ctx.tdzGlobals.has(name) ? analyzeTdzAccess(ctx, id) : "skip";
    if (tdzResult === "check") {
      emitTdzCheck(ctx, fctx, name);
    } else if (tdzResult === "throw") {
      emitStaticTdzThrow(ctx, fctx, id.text);
    }
    return emitCapturedBoxGlobalRead(ctx, fctx, capturedBox);
  }

  // Check captured globals (variables promoted from enclosing scope for callbacks)
  const capturedIdx = ctx.capturedGlobals.get(name);
  if (capturedIdx !== undefined) {
    // TDZ check: throw ReferenceError if let/const variable accessed before initialization
    // Apply static analysis — captured globals are often accessed from closures,
    // but analyzeTdzAccess handles the cross-function case correctly (returns "check")
    const tdzResult = ctx.tdzGlobals.has(name) ? analyzeTdzAccess(ctx, id) : "skip";
    if (tdzResult === "check") {
      emitTdzCheck(ctx, fctx, name);
    } else if (tdzResult === "throw") {
      emitStaticTdzThrow(ctx, fctx, id.text);
    }
    fctx.body.push({ op: "global.get", index: capturedIdx });
    const globalDef = ctx.mod.globals[localGlobalIdx(ctx, capturedIdx)];
    const gType = globalDef?.type ?? { kind: "f64" };
    // Globals widened from ref to ref_null for null init — narrow back
    if (gType.kind === "ref_null" && (ctx.capturedGlobalsWidened.has(name) || fctx.narrowedNonNull?.has(name))) {
      fctx.body.push({ op: "ref.as_non_null" });
      return { kind: "ref", typeIdx: gType.typeIdx };
    }
    return gType;
  }

  // Check module-level globals (top-level let/const declarations)
  const moduleIdx = ctx.moduleGlobals.get(name);
  if (moduleIdx !== undefined) {
    // TDZ check: throw ReferenceError if let/const variable accessed before initialization
    // Apply static analysis for module-level globals
    const tdzResult = ctx.tdzGlobals.has(name) ? analyzeTdzAccess(ctx, id) : "skip";
    if (tdzResult === "check") {
      emitTdzCheck(ctx, fctx, name);
    } else if (tdzResult === "throw") {
      emitStaticTdzThrow(ctx, fctx, id.text);
    }
    fctx.body.push({ op: "global.get", index: moduleIdx });
    const globalDef = ctx.mod.globals[localGlobalIdx(ctx, moduleIdx)];
    const mType = globalDef?.type ?? { kind: "f64" };
    // Null narrowing for module globals
    if (mType.kind === "ref_null" && fctx.narrowedNonNull?.has(name)) {
      fctx.body.push({ op: "ref.as_non_null" });
      return { kind: "ref", typeIdx: (mType as any).typeIdx };
    }
    return mType;
  }

  // Named node:fs imports are stripped into ambient declarations before
  // codegen. WASI owns only their direct-call lowering; materialising one as a
  // first-class value would otherwise produce an inert placeholder and let an
  // alias call disappear. Local/module/captured shadows have already returned
  // above, so this is the unshadowed imported binding.
  if (ctx.wasi && isUnaliasedNodeFsImportBinding(ctx, id)) {
    reportError(
      ctx,
      id,
      `WASI node:fs binding '${name}' may only be used as a directly supported call; first-class aliases are unavailable`,
    );
    fctx.body.push({ op: "ref.null.extern" });
    return { kind: "externref" };
  }

  // A first-class read of the unshadowed global `%eval%` (`var indirect =
  // eval`) must produce the provider's callable, realm-stable intrinsic
  // marker. Syntactic direct/sequence calls are intercepted in calls.ts before
  // identifier lowering reaches this branch; this is the value path that used
  // to fall through to `ref.null.extern` and made every AOT eval alias inert.
  if (ctx.standalone && name === "eval") {
    const declaration = ctx.oracle.valueDeclarationOf(id);
    const isGlobalIntrinsic = declaration === undefined || declaration.getSourceFile().isDeclarationFile;
    if (isGlobalIntrinsic) {
      const valueType = emitStandaloneIntrinsicEvalValue(ctx, fctx);
      if (valueType !== undefined) return valueType;
    }
  }
  // `%Function%` is a genuine realm-owned callable in runtime-eval builds.
  // Direct `Function(...)` / `new Function(...)` syntax is intercepted before
  // identifier lowering; this branch preserves first-class aliases and the
  // constructor identity inherited by provider-owned interpreted functions.
  // (#4442) Through the SHARED emitter, so this read and the `<fn>.constructor`
  // arm cannot disagree — behaviour here is unchanged (function-intrinsic-carrier.ts).
  if (ctx.standalone && name === "Function") {
    const declaration = ctx.oracle.valueDeclarationOf(id);
    const isGlobalIntrinsic = declaration === undefined || declaration.getSourceFile().isDeclarationFile;
    if (isGlobalIntrinsic) {
      const valueType = emitStandaloneFunctionIntrinsicValue(ctx, fctx);
      if (valueType !== undefined) return valueType;
    }
  }
  const globalFunction = tryEmitStandaloneGlobalFunctionIdentifier(ctx, fctx, name, id);
  if (globalFunction) return globalFunction;
  if (ctx.sloppyImplicitGlobals?.has(name)) return emitImplicitGlobalRead(ctx, fctx, name);
  // Standalone built-in namespace values (Array/Object) materialize as lazy
  // open-object singletons before ambient lib declarations can route them to
  // host globals.
  if (ctx.standalone && isSupportedBuiltinNamespace(name)) {
    const builtinObject = emitBuiltinNamespaceObject(ctx, fctx, name);
    if (builtinObject) return builtinObject;
  }

  // Host/gc: an ambient extern constructor used as a VALUE must resolve to the
  // real host constructor object.  The extern-class registry normally serves
  // only `new X()` and instance member dispatch, so a bare value read such as
  // ReactDOM's feature selection
  //
  //   typeof AbortController !== "undefined" ? AbortController : fallback
  //
  // previously fell through to null.  Resolve every registered, unshadowed
  // extern constructor through globalThis generically; this covers Web/API
  // constructors without extending the TypedArray/ERM name allowlists below.
  // Standalone/WASI deliberately keep their native/no-host behavior.
  if (
    !ctx.standalone &&
    !ctx.wasi &&
    ctx.externClasses.has(name) &&
    fctx.localMap.get(name) === undefined &&
    !(fctx.boxedCaptures?.has(name) ?? false) &&
    !ctx.classSet.has(name)
  ) {
    const gtFuncIdx = ensureLateImport(ctx, "__get_globalThis", [], [{ kind: "externref" }]);
    const getIdx = ensureLateImport(
      ctx,
      "__extern_get",
      [{ kind: "externref" }, { kind: "externref" }],
      [{ kind: "externref" }],
    );
    flushLateImportShifts(ctx, fctx);
    if (gtFuncIdx !== undefined && getIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx: gtFuncIdx });
      addStringConstantGlobal(ctx, name);
      const strGlobalIdx = ctx.stringGlobalMap.get(name);
      fctx.body.push(
        strGlobalIdx !== undefined ? { op: "global.get", index: strGlobalIdx } : { op: "ref.null.extern" },
      );
      fctx.body.push({ op: "call", funcIdx: getIdx });
      return { kind: "externref" };
    }
  }

  // (#3087) Host/gc lane: a bare TypedArray constructor name used as a VALUE
  // (not `new TA()` / type position) resolves to the REAL host constructor
  // externref via `__extern_get(__get_globalThis(), name)` — mirroring the #820h
  // ERM-global-as-value pattern above. Placed BEFORE the ambient `declaredGlobals`
  // route (which maps a bare `Int8Array` to a stub host import that returns
  // `undefined` — so `constructors = [Int8Array, …]` degraded to a null carrier
  // and a dynamic `new TA(...)` through the `__construct_closure` bridge saw
  // "undefined is not a constructor"). This materializes the genuine host
  // constructor so `fn(constructors[i])` and dynamic `new TA(...)` (#3087, the
  // dominant #3074 downstream honest-fail) execute and pass. Covers the BigInt
  // views too (not in the standalone `taCtorKindOf` list). Standalone/WASI keeps
  // the native `$__ta_ctor` value below (host-free). Gated so a real
  // local/captured/module/class binding — already returned above — wins.
  if (
    !ctx.standalone &&
    !ctx.wasi &&
    (taCtorKindOf(name) >= 0 || name === "BigInt64Array" || name === "BigUint64Array") &&
    fctx.localMap.get(name) === undefined &&
    !(fctx.boxedCaptures?.has(name) ?? false) &&
    !ctx.classSet.has(name)
  ) {
    const gtFuncIdx = ensureLateImport(ctx, "__get_globalThis", [], [{ kind: "externref" }]);
    const getIdx = ensureLateImport(
      ctx,
      "__extern_get",
      [{ kind: "externref" }, { kind: "externref" }],
      [{ kind: "externref" }],
    );
    flushLateImportShifts(ctx, fctx);
    if (gtFuncIdx !== undefined && getIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx: gtFuncIdx });
      addStringConstantGlobal(ctx, name);
      const strGlobalIdx = ctx.stringGlobalMap.get(name);
      if (strGlobalIdx !== undefined) {
        fctx.body.push({ op: "global.get", index: strGlobalIdx });
      } else {
        fctx.body.push({ op: "ref.null.extern" });
      }
      fctx.body.push({ op: "call", funcIdx: getIdx });
      return { kind: "externref" };
    }
  }

  // Check declared globals (e.g. document, window)
  const globalInfo = ctx.declaredGlobals.get(name);
  if (globalInfo) {
    fctx.body.push({ op: "call", funcIdx: globalInfo.funcIdx });
    return globalInfo.type;
  }

  // (#1395) Class identifier as a value — emit lazy-initialized class-object
  // singleton, registering static-method names with the runtime's
  // `_staticMethodNames` allowlist so `Object.getOwnPropertyDescriptor(C, "m")`
  // returns the spec-correct descriptor for static methods. Without this,
  // bare `C` falls through to the `ref.null.extern` graceful-default below
  // and `getOwnPropertyDescriptor(null, "m")` returns null, breaking
  // verifyProperty-style static-method tests under
  // `language/{statements,expressions}/class/elements/`.
  //
  // For class expressions (`var C = class { ... }`), `classExprNameMap` maps
  // the user-visible name "C" to the synthetic internal name (e.g.
  // `__anonClass_0`). All static-prop / static-method storage is keyed on the
  // synthetic name, so `C.f` (via property-access) reads from
  // `__static___anonClass_0_f`. Resolving the bare `C` identifier must go
  // through the same alias so the LHS of `C.f() === C` and the RHS read the
  // SAME `__class_<Name>` singleton; otherwise the comparison ends up with
  // `__class___anonClass_0` on the LHS (returned by the arrow body via the
  // synthetic-name `enclosingClassName`) and `__class_C` on the RHS, which
  // are distinct singletons and break identity. (#1395 Phase 1 follow-up.)
  //
  // Order matters: this is AFTER `localMap`, `capturedGlobals`,
  // `moduleGlobals`, and `declaredGlobals` so user shadowing
  // (`var C = ...; class C {}` — though unusual) takes precedence.
  // It is BEFORE the funcMap-funcref path so a class never gets re-wrapped
  // as a closure, and BEFORE the `ref.null.extern` fallback so we beat the
  // null result.
  {
    const resolvedClassName = ctx.classExprNameMap.get(name) ?? name;
    if (ctx.classObjectGlobals?.has(resolvedClassName)) {
      if (emitLazyClassObjectGet(ctx, fctx, resolvedClassName)) {
        return { kind: "externref" };
      }
    }
  }

  // (#2623 Slice B) A `class … extends Promise` is externref-backed (#1366a/b)
  // and therefore has NO `__class_<Name>` singleton global (the block above is
  // skipped — `classObjectGlobals` never holds it). Reading the class as a VALUE
  // (`Sub` on the RHS of `=== Sub`, `instanceof Sub`, `Promise.try.call(Sub,…)`)
  // previously fell through to the `ref.null.extern` graceful-default, yielding
  // `null` — a DIFFERENT object than the synthesized `__promise_subclass_ctor`
  // the combinator capability path builds the instance from, so
  // `instance.constructor === Sub` / `instance instanceof Sub` were always
  // false. Route the value-read through the SAME cached singleton so there is
  // exactly one constructor object per Promise-subclass name. JS-host only;
  // the helper returns false in standalone/WASI so the fallback default stands.
  // Order: AFTER local/captured/module/declared-global shadowing (so a user
  // binding wins) and AFTER the class-object-singleton block (a non-Promise
  // class keeps its `__class_<Name>` identity); BEFORE the null fallback.
  if (
    ctx.classSet.has(ctx.classExprNameMap.get(name) ?? name) &&
    !fctx.localMap.has(name) &&
    !(fctx.boxedCaptures?.has(name) ?? false)
  ) {
    if (tryEmitPromiseSubclassValue(ctx, fctx, name)) {
      return { kind: "externref" };
    }
  }

  // (#3006) Standalone bare builtin-CONSTRUCTOR identifier read as a VALUE
  // (`… === Set`, `assert.sameValue(…, Set)`, `[Set, Map]`) → the GENUINE,
  // identity-stable reified constructor object, NOT the null-externref carrier it
  // otherwise falls through to. This is the RHS partner of the
  // `<Builtin>.prototype.constructor` fold in property-access.ts: both resolve to
  // the SAME per-name `__builtin_ctor_<Name>` singleton, so
  // `Set.prototype.constructor === Set` is genuinely true and
  // `Set.prototype.constructor === Map` genuinely false (distinct singletons).
  // Scoped to the narrow constructor subset with no existing bare-value identity
  // (Set/Map/Weak*/RegExp/FinalizationRegistry/Disposable*/SuppressedError) and to
  // standalone; gc/host and the namespace-object / native-error-tag builtins are
  // untouched. Order: AFTER local/module/declared-global shadowing and the
  // class-object / promise-subclass singleton blocks (so a user binding or a real
  // class always wins), BEFORE the null-externref fallback.
  if (ctx.standalone && isBuiltinConstructorIdentityName(name)) {
    return emitBuiltinConstructorIdentity(ctx, fctx, name);
  }

  // #1502 — Browser Storage globals (localStorage / sessionStorage). Emit
  // a host import that resolves to the real browser Storage when running
  // inside a browser / jsdom, and to an in-memory polyfill in standalone
  // mode (Node / Bun / WASI). Recognised by name so callers don't need a
  // `declare var` in source — lib.dom.d.ts already provides the type.
  if (name === "localStorage" || name === "sessionStorage") {
    const importName = name === "localStorage" ? "__get_localStorage" : "__get_sessionStorage";
    let funcIdx = ctx.funcMap.get(importName);
    if (funcIdx === undefined) {
      const importsBefore = ctx.numImportFuncs;
      const typeIdx = addFuncType(ctx, [], [{ kind: "externref" }]);
      addImport(ctx, "env", importName, { kind: "func", typeIdx });
      shiftLateImportIndices(ctx, fctx, importsBefore, ctx.numImportFuncs - importsBefore);
      funcIdx = ctx.funcMap.get(importName)!;
    }
    fctx.body.push({ op: "call", funcIdx });
    return { kind: "externref" };
  }

  // #1494 — Node module-scope values: `__dirname` and `__filename`. Recognize
  // them even when the source has no `@types/node` shim so plain `.ts` modules
  // compile cleanly. The host import returns the loader-injected value
  // (typed externref / string).
  if (name === "__dirname" || name === "__filename") {
    const importName = name === "__dirname" ? "__get_dirname" : "__get_filename";
    let funcIdx = ctx.funcMap.get(importName);
    if (funcIdx === undefined) {
      const importsBefore = ctx.numImportFuncs;
      const typeIdx = addFuncType(ctx, [], [{ kind: "externref" }]);
      addImport(ctx, "env", importName, { kind: "func", typeIdx });
      shiftLateImportIndices(ctx, fctx, importsBefore, ctx.numImportFuncs - importsBefore);
      funcIdx = ctx.funcMap.get(importName)!;
    }
    fctx.body.push({ op: "call", funcIdx });
    return { kind: "externref" };
  }

  // #3995 — Node's `global` is an alias of `globalThis`. Lodash deliberately
  // probes that alias before falling back to `Function("return this")()`. The
  // latter is dynamic code and may be unavailable, so lowering an unshadowed
  // Node-platform `global` to null made the fallback run and aborted the whole
  // CommonJS graph during module initialization.
  //
  // This check is after lexical/module/capture resolution, so a user binding
  // named `global` still wins. Web/Deno and platform-unspecified builds keep
  // their previous behavior.
  const isNodeGlobalAlias = name === "global" && ctx.nodeGlobals;

  // globalThis (and Node's unshadowed `global` alias) — return the JS global object.
  if (name === "globalThis" || isNodeGlobalAlias) {
    // (#2996) Standalone / WASI (no-JS-host): resolve to a native, cached
    // `$Object` singleton instead of the `env::__get_globalThis` host import,
    // which a host-free binary can't satisfy (it merely leaks into the import
    // section). This eliminates the biggest genuine sole-import leak lever
    // (47 tests) — READ-value substrate only; `globalThis.prop` reflective reads
    // are the deferred #2988 MOP work and keep their existing path. Host/gc mode
    // is byte-identical (falls through to the host import below).
    if (ctx.standalone || ctx.wasi) {
      const nativeVt = emitNativeGlobalThisObject(ctx, fctx);
      if (nativeVt) return nativeVt;
      // Native runtime unavailable — fall through to the host-import path.
    }
    let funcIdx = ctx.funcMap.get("__get_globalThis");
    if (funcIdx === undefined) {
      const importsBefore = ctx.numImportFuncs;
      const typeIdx = addFuncType(ctx, [], [{ kind: "externref" }]);
      addImport(ctx, "env", "__get_globalThis", { kind: "func", typeIdx });
      shiftLateImportIndices(ctx, fctx, importsBefore, ctx.numImportFuncs - importsBefore);
      funcIdx = ctx.funcMap.get("__get_globalThis")!;
    }
    fctx.body.push({ op: "call", funcIdx });
    return { kind: "externref" };
  }

  // (#820h) Explicit Resource Management constructors referenced as *values*
  // (not in `new`/method position) — e.g. `DisposableStack.prototype`,
  // `Reflect.construct(DisposableStack, …)`, `Object.getOwnPropertyDescriptor`.
  // The extern-class machinery only models `new X()` / `x.method()`; a bare
  // identifier falls through to the null-externref fallback below, so reflective
  // test262 cases see `null` instead of the host constructor. Resolve them to
  // the real host global via `__extern_get(__get_globalThis(), name)` so the
  // native constructor object (with its prototype + accessor descriptors) is
  // visible. Scope strictly to these host-delegated ERM globals and only when
  // the name is not shadowed by a local/captured binding.
  //
  // (#2029) HOST-ONLY: this whole fast path uses the `__get_globalThis` /
  // `__extern_get` host imports (absent in no-JS-host targets) AND pushes the
  // ctor-name string key via a string-constant global — which under
  // standalone/nativeStrings is the `-1` sentinel, baking `global.get -1`
  // ("global index out of range — -1") at serialize time. It also leaks two
  // host imports that an empty import object can't satisfy. The reflective
  // `Object.getPrototypeOf(SuppressedError)` / `isConstructor(DisposableStack)`
  // shapes (built-ins/{SuppressedError,DisposableStack,AsyncDisposableStack}/
  // {proto,is-a-constructor}.js) hit this. Gate to gc/host; standalone falls
  // through to the clean located refusal (the #1888 dual-mode invariant).
  if (
    !ctx.standalone &&
    !ctx.wasi &&
    (name === "DisposableStack" || name === "AsyncDisposableStack" || name === "SuppressedError") &&
    !fctx.localMap.has(name) &&
    !(fctx.boxedCaptures?.has(name) ?? false) &&
    !ctx.classSet.has(name)
  ) {
    const gtFuncIdx = ensureLateImport(ctx, "__get_globalThis", [], [{ kind: "externref" }]);
    const getIdx = ensureLateImport(
      ctx,
      "__extern_get",
      [{ kind: "externref" }, { kind: "externref" }],
      [{ kind: "externref" }],
    );
    flushLateImportShifts(ctx, fctx);
    if (gtFuncIdx !== undefined && getIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx: gtFuncIdx });
      addStringConstantGlobal(ctx, name);
      const strGlobalIdx = ctx.stringGlobalMap.get(name);
      if (strGlobalIdx !== undefined) {
        fctx.body.push({ op: "global.get", index: strGlobalIdx });
      } else {
        fctx.body.push({ op: "ref.null.extern" });
      }
      fctx.body.push({ op: "call", funcIdx: getIdx });
      return { kind: "externref" };
    }
  }

  // Built-in numeric constants: NaN, Infinity
  if (name === "NaN") {
    fctx.body.push({ op: "f64.const", value: NaN });
    return { kind: "f64" };
  }
  if (name === "Infinity") {
    fctx.body.push({ op: "f64.const", value: Infinity });
    return { kind: "f64" };
  }

  // (#2931) Reassigned function-declaration live binding: the name (or an import
  // alias of it) is backed by a mutable `externref` module global that both the
  // reassignment (`global.set`) and every read go through, so a later read
  // observes `fn = …`. Read through the global. Checked before the funcref-value
  // path (which would otherwise re-wrap the func index into a fresh closure,
  // ignoring the live value). Gated on the normally-empty set — byte-identical
  // for programs that never reassign a function declaration.
  if (fctx.localMap.get(name) === undefined && ctx.liveFuncBindingGlobals?.has(name)) {
    const liveGlobalIdx = ctx.moduleGlobals.get(name);
    if (liveGlobalIdx !== undefined) {
      fctx.body.push({ op: "global.get", index: liveGlobalIdx });
      return { kind: "externref" };
    }
  }

  // Function reference as value: when a known function name is used as an
  // expression (not called), wrap it in a closure struct so it can be stored
  // in a variable and later called via call_ref.
  // Only wrap user-defined functions (skip internal helpers and class constructors).
  const funcRefIdx = ctx.funcMap.get(name);
  // (#1809) Only wrap DEFINED functions (index >= numImportFuncs) in a funcref
  // closure. A host import (e.g. the ambient DOM global `resizeTo`/`resizeBy`
  // from lib.dom.d.ts) has no in-module body to forward to via `ref.func`, so
  // building a cached/per-site closure trampoline around its import index is
  // never correct. When the funcMap entry resolves to an import, the captured
  // `methodFuncIdx` later trips the `finalizeMethodTrampolines` guard
  // ("methodFuncIdx N points at import …— shift walker missed this") as a hard
  // compile error (157 default-lane tests, #1525b-regression-tagged). This is
  // not a shift-walker miss — the index was an import from the start. Skip the
  // closure path for imports so the identifier falls through to the
  // type-appropriate graceful default below (valid Wasm, no spurious throw).
  //
  // (#3087) A `__`-prefixed name is only skipped when it does NOT resolve to a
  // USER function declaration in the compiled source. The old blunt
  // `!name.startsWith("__")` filter existed to keep compiler-internal DEFINED
  // helpers that share the funcMap namespace (`__module_init`, `__closure_N`,
  // `__call_fn_N`, method trampolines, …) out of the closure-wrap path — but it
  // also silently compiled a user-defined `__foo` referenced as a VALUE to the
  // graceful null default, so `var f: any = __foo; f(x)` dispatched on null and
  // the call was dropped. That was the dominant honest-fail of the ~1,487-file
  // test262 TypedArray harness cluster: the runner shim passes
  // `__ta_makeCtorArgPassthrough` positionally into every callback, so
  // `makeCtorArg(...)` returned null and `new TA(null)` built a length-0 view.
  // Discriminate by the checker instead: a source-level function declaration
  // resolves to a symbol whose valueDeclaration is a FunctionDeclaration;
  // compiler-internal helper names do not resolve to any source declaration.
  const isInternalHelperName = (): boolean => {
    if (!name.startsWith("__")) return false;
    const valSym = identifierValueSymbol(ctx, id);
    const valDecl = valSym?.valueDeclaration;
    return !(valDecl !== undefined && ts.isFunctionDeclaration(valDecl));
  };
  if (
    funcRefIdx !== undefined &&
    definedFuncAt(ctx, funcRefIdx) !== undefined &&
    !isInternalHelperName() &&
    !ctx.classSet.has(name)
  ) {
    const valueDecl = identifierValueSymbol(ctx, id)?.valueDeclaration;
    const isOrdinaryFunctionDecl =
      (noJsHost(ctx) || ctx.targetProfile.semanticProviders === "native-first") &&
      valueDecl !== undefined &&
      ts.isFunctionDeclaration(valueDecl) &&
      valueDecl.asteriskToken === undefined &&
      !(valueDecl.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ?? false);
    // Check if there's already a closure registered (e.g. from closureMap)
    const existingClosure = ctx.closureMap.get(name);
    if (existingClosure) {
      // Already a closure — check if there's a module-level global for it
      const closureModGlobal = ctx.moduleGlobals.get(name);
      if (closureModGlobal !== undefined) {
        fctx.body.push({ op: "global.get", index: closureModGlobal });
        const globalDef = ctx.mod.globals[localGlobalIdx(ctx, closureModGlobal)];
        return (
          globalDef?.type ?? {
            kind: "ref",
            typeIdx: existingClosure.structTypeIdx,
          }
        );
      }
    }
    // (#1340) For captureless top-level function decls, emit a cached
    // singleton closure so identity is preserved across textual occurrences.
    // Without this, `foo === foo` is false and any sidecar write keyed by the
    // per-site struct (e.g. `foo.prototype = X`) does not round-trip — which
    // is what made the test262 Iterator.prototype.* shim show up as
    // misclassified "wasm_compile" errors. Captures must be filled at the
    // construction site (per-instance), so we only take the cached path when
    // no captures are required.
    const nestedCaptures = ctx.nestedFuncCaptures.get(name);
    if (!nestedCaptures || nestedCaptures.length === 0) {
      const cachedRefType = emitCachedFuncClosureAccess(ctx, fctx, name, funcRefIdx, isOrdinaryFunctionDecl);
      if (cachedRefType) {
        return cachedRefType;
      }
    }
    // Fallback: per-site closure struct (with captures, or if cache emit failed).
    const refType = emitFuncRefAsClosure(ctx, fctx, name, funcRefIdx, isOrdinaryFunctionDecl);
    if (refType) return refType;
  }

  // Check if this is a truly undeclared variable (no TS symbol).
  // Accessing an undeclared variable should throw ReferenceError per JS strict mode
  // (spec §13.10.1 / §13.11.4 — operand evaluation precedes ToPrimitive in `==`).
  // However, known globals (Symbol, Object, Reflect, etc.) have TS symbols from
  // lib.d.ts and should use the fallback default instead.
  const sym = identifierValueSymbol(ctx, id);
  if (!sym) {
    if ((ctx.standalone || ctx.wasi) && ctx.runtimeEvalGlobalFunctionBindings) {
      const dynamicGlobal = skipRuntimeEvalState
        ? emitRuntimeEvalGlobalRead(ctx, fctx, name, false)
        : emitRuntimeEvalBindingRead(ctx, fctx, name, false);
      if (dynamicGlobal !== null) return dynamicGlobal;
    }
    // Truly undeclared variable — throw a proper ReferenceError instance.
    // The previous emission was a raw `throw ref.null.extern`, which surfaced
    // to JS as `null` so `e instanceof ReferenceError` was false (#1380,
    // S11.9.1_A2.1_T3).
    const msg = `${name} is not defined`;
    // #1473 — no JS host: build the ReferenceError instance in-module so
    // `e instanceof ReferenceError` works under wasmtime, with no
    // `__throw_reference_error` host import.
    if (noJsHost(ctx)) {
      emitThrowReferenceError(ctx, fctx, msg);
      fctx.body.push({ op: "unreachable" });
      return { kind: "externref" };
    }
    const throwRefErrIdx = ensureLateImport(ctx, "__throw_reference_error", [{ kind: "externref" }], []);
    flushLateImportShifts(ctx, fctx);
    if (throwRefErrIdx !== undefined) {
      addStringConstantGlobal(ctx, msg);
      const strIdx = ctx.stringGlobalMap.get(msg)!;
      fctx.body.push({ op: "global.get", index: strIdx });
      fctx.body.push({ op: "call", funcIdx: throwRefErrIdx });
      fctx.body.push({ op: "unreachable" });
    } else {
      // Fallback: raw exception-tag throw (no JS host to construct a ReferenceError).
      const tagIdx = ensureExnTag(ctx);
      fctx.body.push({ op: "ref.null.extern" });
      fctx.body.push({ op: "throw", tagIdx });
    }
    return { kind: "externref" };
  }

  // (#3054 D) First-class TypedArray CONSTRUCTOR value. A bare TA name used as a
  // VALUE (not `new TA()` / type position — those are handled syntactically in
  // new-super / property-access) previously fell through to the null-externref
  // default below, so every TA ctor was indistinguishable (`Uint8Array ===
  // Int8Array` was `true`) and a dynamic `new ctor(rab)` dropped the ctor. Emit a
  // `$__ta_ctor{kind}` so `ctors = [Uint8Array, …]`, `for (ctor of ctors)`, and
  // dynamic `new ctor(rab)` / `ctor.BYTES_PER_ELEMENT` work. Standalone/WASI lane
  // only (the view/construct substrate is host-free); gated on the name not being
  // shadowed by a local/captured binding or a user class.
  if (
    noJsHost(ctx) &&
    taCtorKindOf(name) >= 0 &&
    fctx.localMap.get(name) === undefined &&
    !(fctx.boxedCaptures?.has(name) ?? false) &&
    !ctx.classSet.has(name)
  ) {
    const taCtorVt = emitTaCtorValue(ctx, fctx, name);
    if (taCtorVt) return taCtorVt;
  }

  // Graceful fallback for known but unimplemented globals (Symbol, Object,
  // Reflect, etc.) — emit a type-appropriate default so compilation continues.
  reportSilentFallback(ctx, "const-fallback", "identifiers:unimplemented-global-default", id, id.text);
  const tsType = ctx.checker.getTypeAtLocation(id);
  const wasmType = resolveWasmType(ctx, tsType);
  if (wasmType.kind === "f64") {
    fctx.body.push({ op: "f64.const", value: 0 });
    return { kind: "f64" };
  }
  if (wasmType.kind === "i32") {
    fctx.body.push({ op: "i32.const", value: 0 });
    return { kind: "i32" };
  }
  if (wasmType.kind === "i64") {
    fctx.body.push({ op: "i64.const", value: 0n });
    return { kind: "i64" };
  }
  fctx.body.push({ op: "ref.null.extern" });
  return { kind: "externref" };
}

/**
 * If the narrowed TS type indicates a concrete primitive, emit an unbox call
 * and return the unboxed ValType. The externref value must already be on stack.
 * Returns null if no unboxing is needed (type is still a union or externref).
 */
function narrowTypeToUnbox(ctx: CodegenContext, fctx: FunctionContext, narrowedType: ts.Type): ValType | null {
  // Don't unbox if the narrowed type is still a heterogeneous union
  if (isHeterogeneousUnion(narrowedType, ctx.checker)) return null;
  // Don't unbox if still a union with null/undefined (stays externref)
  if (narrowedType.isUnion()) return null;

  if (isNumberType(narrowedType)) {
    addUnionImports(ctx);
    const funcIdx = ctx.funcMap.get("__unbox_number");
    if (funcIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx });
      return { kind: "f64" };
    }
  }
  if (isBooleanType(narrowedType)) {
    addUnionImports(ctx);
    const funcIdx = ctx.funcMap.get("__unbox_boolean");
    if (funcIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx });
      return { kind: "i32" };
    }
  }
  if (isBigIntType(narrowedType)) {
    addUnionImports(ctx);
    const funcIdx = ctx.funcMap.get("__to_bigint");
    if (funcIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx });
      return { kind: "i64", bigint: true };
    }
  }
  // String stays as externref — no unboxing needed
  if (isStringType(narrowedType)) return null;

  return null;
}

// ── instanceof (extracted to ./typeof-delete.ts) ──

/**
 * Try to resolve the right-hand side of an instanceof expression to a known
 * class in our struct system. Returns the class name if found, undefined otherwise.
 * This mirrors resolveInstanceOfClassName in typeof-delete.ts but is used to
 * decide whether to use the host fallback.
 */
function resolveInstanceOfRHS(ctx: CodegenContext, rightExpr: ts.Expression): string | undefined {
  if (ts.isIdentifier(rightExpr)) {
    const name = rightExpr.text;
    if (ctx.classTagMap.has(name)) return name;
    const mapped = ctx.classExprNameMap.get(name);
    if (mapped && ctx.classTagMap.has(mapped)) return mapped;
  }
  const tsType = ctx.checker.getTypeAtLocation(rightExpr);
  const constructSigs = tsType.getConstructSignatures?.();
  if (constructSigs && constructSigs.length > 0) {
    const instanceType = constructSigs[0]!.getReturnType();
    const symbolName = instanceType.getSymbol()?.name;
    if (symbolName) {
      if (ctx.classTagMap.has(symbolName)) return symbolName;
      const mapped = ctx.classExprNameMap.get(symbolName);
      if (mapped && ctx.classTagMap.has(mapped)) return mapped;
    }
  }
  const symbolName = tsType.getSymbol()?.name;
  if (symbolName) {
    if (ctx.classTagMap.has(symbolName)) return symbolName;
    const mapped = ctx.classExprNameMap.get(symbolName);
    if (mapped && ctx.classTagMap.has(mapped)) return mapped;
  }
  return undefined;
}

/**
 * Try to statically evaluate `LHS instanceof <ctorName>` using the LHS TypeScript
 * type and the built-in type-tag registry (#1325).
 *
 * Returns:
 *   - `true`  → result is provably 1
 *   - `false` → result is provably 0
 *   - `undefined` → cannot decide statically, fall through to runtime check
 *
 * This lets the compiler emit `i32.const 0/1` (after compiling LHS for side
 * effects) without consulting the `__instanceof` JS host import — important
 * for standalone / WASI mode where the import is unavailable.
 */
function tryStaticInstanceOf(ctx: CodegenContext, expr: ts.BinaryExpression, ctorName: string): boolean | undefined {
  if (!isBuiltinTypeName(ctorName)) return undefined;

  // 1. LHS is a user class? A WasmGC user-class struct is never an instance of
  //    a JS built-in (Array / Error / Map / ...).
  const leftTsType = ctx.checker.getTypeAtLocation(expr.left);
  let lhsSymbolName = leftTsType.getSymbol()?.name;
  // (#1455) Resolve TypeScript's synthetic `__class` symbol name for
  // anonymous class expressions (`const Sub = class extends Map {}`) via the
  // type string + classExprNameMap so subclass-of-builtin reasoning works.
  if (lhsSymbolName === "__class") {
    const typeStr = ctx.checker.typeToString(leftTsType);
    const mapped = ctx.classExprNameMap.get(typeStr);
    if (mapped !== undefined) {
      lhsSymbolName = mapped;
    } else if (ctx.classTagMap.has(typeStr)) {
      lhsSymbolName = typeStr;
    }
  }
  if (lhsSymbolName !== undefined) {
    if (ctx.classTagMap.has(lhsSymbolName)) {
      // (#1366a) Externref-backed subclass (e.g. `class MyError extends Error`)
      // — the runtime instance IS a real JS instance of its built-in parent
      // (and any super-builtin). Walk the recorded built-in parent name
      // through the BUILTIN_PARENT chain to decide.
      const builtinParent = ctx.classBuiltinParentMap?.get(lhsSymbolName);
      if (builtinParent !== undefined) {
        return isBuiltinSubtype(builtinParent, ctorName);
      }
      // (#1729) A user-class instance with no builtin parent is still an
      // `instanceof Object` (its prototype chain ends at Object.prototype).
      // Any other builtin RHS is false (a plain user struct isn't a Map/Array/…).
      return ctorName === "Object";
    }
    // 2. LHS is itself a built-in (or matches the constructor's instance-type
    //    name) — apply hierarchy reasoning. Every builtin instance is also an
    //    `instanceof Object` (#1729), so Object is a universal yes here.
    if (isBuiltinTypeName(lhsSymbolName)) {
      if (ctorName === "Object") return true;
      return isBuiltinSubtype(lhsSymbolName, ctorName);
    }
  }

  // 3. LHS is a numeric / boolean primitive → instanceof of any object type is
  //    always false. (Skip strings — `"" instanceof String` is false but the
  //    TS type may be the wrapper, so we leave that to runtime.)
  if (isNumberType(leftTsType) || isBooleanType(leftTsType)) {
    return false;
  }

  // 4. (#1729) `<obj> instanceof Object` is true for every object value
  //    (§7.3.20 OrdinaryHasInstance walks the prototype chain to
  //    Object.prototype). WasmGC-struct-backed values — object literals,
  //    arrays, tuples — are not real host objects, so the runtime
  //    `__instanceof` falls through to a spurious `false`. Short-circuit to
  //    `true` when the RHS is `Object` and the LHS is a provably non-primitive
  //    object type. Guarded against primitives / null / undefined / any /
  //    unknown so only definite objects qualify. (User-class instances are
  //    handled by the `classTagMap` branch above, which returns before here.)
  if (ctorName === "Object") {
    const f = leftTsType.flags;
    const isPrimitiveOrIndeterminate =
      (f &
        (ts.TypeFlags.Any |
          ts.TypeFlags.Unknown |
          ts.TypeFlags.NumberLike |
          ts.TypeFlags.StringLike |
          ts.TypeFlags.BooleanLike |
          ts.TypeFlags.BigIntLike |
          ts.TypeFlags.ESSymbolLike |
          ts.TypeFlags.Null |
          ts.TypeFlags.Undefined |
          ts.TypeFlags.Void |
          ts.TypeFlags.Never)) !==
      0;
    // Object literals, arrays, and tuples all carry the Object type flag.
    if (!isPrimitiveOrIndeterminate && (f & ts.TypeFlags.Object) !== 0) {
      return true;
    }
  }

  return undefined;
}

/**
 * Emit a constant-result `instanceof` after still compiling the LHS for side
 * effects. Used by `compileHostInstanceOf` when `tryStaticInstanceOf` resolves
 * the answer at compile time.
 */
function emitConstantInstanceOf(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.BinaryExpression,
  result: boolean,
): ValType {
  const leftType = compileExpression(ctx, fctx, expr.left);
  if (leftType) fctx.body.push({ op: "drop" });
  fctx.body.push({ op: "i32.const", value: result ? 1 : 0 });
  return { kind: "i32" };
}

function identifierHasSourceDeclaration(ctx: CodegenContext, id: ts.Identifier): boolean {
  const symbol = identifierValueSymbol(ctx, id);
  const declarations = symbol?.declarations ?? [];
  return declarations.some((decl) => !decl.getSourceFile().isDeclarationFile);
}

/**
 * (#2702) Given the i32 tri-state result of an instanceof host check on the
 * stack — 0 (false) / 1 (true) / 2 (throw) — emit a wasm-level `TypeError`
 * throw for the `2` sentinel and leave the boolean i32 (0/1) on the stack.
 *
 * The throw MUST originate in wasm: a host-thrown JS error loses its identity
 * crossing the wasm catch boundary (the caught binding arrives as `undefined`),
 * so `catch (e) { e instanceof TypeError }` — the exact test262 shape — would
 * fail if the host threw. ECMA-262 §13.10.2 mandates a TypeError when the RHS
 * is not an object, is not callable with no `@@hasInstance`, has a non-callable
 * `@@hasInstance`, or (OrdinaryHasInstance §7.3.20) has a non-object prototype.
 */
function emitInstanceofThrowGuard(ctx: CodegenContext, fctx: FunctionContext): void {
  // stack in: [i32 code]
  const codeLocal = allocLocal(fctx, `__instanceof_code_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "local.tee", index: codeLocal });
  fctx.body.push({ op: "i32.const", value: 2 });
  fctx.body.push({ op: "i32.eq" });
  // Build the throw into a sub-body (the late-import shift walker covers both
  // savedBodies and the active body, so registering __new_TypeError here stays
  // index-consistent with the already-emitted host call).
  const saved = pushBody(fctx);
  emitThrowTypeError(ctx, fctx, "Right-hand side of 'instanceof' is not callable");
  const throwBody = fctx.body;
  popBody(fctx, saved);
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: throwBody,
    else: [],
  });
  fctx.body.push({ op: "local.get", index: codeLocal });
  // stack out: [i32 0|1]
}

/**
 * (#2998) True when `t` is EXCLUSIVELY a primitive value type — every union
 * constituent is a number / string / boolean / bigint / symbol / null /
 * undefined / void, and NONE is `Object` / `any` / `unknown` / a non-primitive
 * brand / a type-parameter. `never` also qualifies: a `never`-typed operand can
 * never produce a value, so any downstream constant is unreachable.
 *
 * Used to short-circuit the fully-dynamic `instanceof` path: §7.3.20
 * OrdinaryHasInstance step 3 ("If Type(O) is not Object, return false") makes a
 * primitive left-hand value answer `false` WITHOUT reading `target.prototype` or
 * walking any prototype chain — so no host predicate is needed.
 */
function isExclusivelyPrimitiveType(t: ts.Type): boolean {
  const PRIM =
    ts.TypeFlags.NumberLike |
    ts.TypeFlags.StringLike |
    ts.TypeFlags.BooleanLike |
    ts.TypeFlags.BigIntLike |
    ts.TypeFlags.ESSymbolLike |
    ts.TypeFlags.Null |
    ts.TypeFlags.Undefined |
    ts.TypeFlags.Void |
    ts.TypeFlags.Never;
  const NON_PRIM =
    ts.TypeFlags.Object |
    ts.TypeFlags.Any |
    ts.TypeFlags.Unknown |
    ts.TypeFlags.NonPrimitive |
    ts.TypeFlags.TypeParameter;
  if (t.isUnion()) return t.types.length > 0 && t.types.every(isExclusivelyPrimitiveType);
  return (t.flags & PRIM) !== 0 && (t.flags & NON_PRIM) === 0;
}

function emitDynamicInstanceOf(ctx: CodegenContext, fctx: FunctionContext, expr: ts.BinaryExpression): ValType {
  // (#2998) Standalone / WASI: when the left-hand operand is STATICALLY and
  // EXCLUSIVELY a primitive, §13.10.2 → §7.3.20 OrdinaryHasInstance step 3
  // ("If Type(O) is not Object, return false") resolves the operator to `false`
  // WITHOUT the `__instanceof_check` host predicate, no prototype read, no
  // proto-chain walk. We still compile BOTH operands (spec evaluates the LHS,
  // then the RHS, before any check — preserving side effects and a RHS
  // ReferenceError / accessor throw), discard them, and push the constant. This
  // retires the `env::__instanceof_check` sole-import leak on the legacy
  // `language/expressions/instanceof/S15.3.5.3_A1_*` (`<primitive> instanceof
  // Function(...)`) and `primitive-prototype-with-primitive` /
  // `prototype-getter-with-primitive` (`0 instanceof Function.prototype`) shapes.
  //
  // Gated on `noJsHost`: in the gc/host lane the import is satisfiable and the
  // runtime predicate still throws a spec TypeError for a genuine-primitive RHS
  // (`1 instanceof <runtime-non-object>`), so that lane is left byte-identical.
  // The object-LHS dynamic path (a real proto-chain-walk membership test) is
  // deferred to the #2916 Slice B substrate.
  // (#2916) §7.3.20 step 1, host-free: a provably non-callable OBJECT RHS
  // throws. Declines (null) in gc/host mode — see native-ordinary-instanceof.ts.
  //
  // (#4484 A) Ordered BEFORE the #2998 primitive-LHS fold below, which is the
  // spec order: OrdinaryHasInstance checks `IsCallable(C)` in step 1 and
  // `Type(V) is Object` only in step 3, so a non-callable RHS throws even for a
  // primitive LHS. With the fold first, `1 instanceof Math` answered `false`
  // (`S11.8.6_A6_T2`, measured fail→pass). Both arms compile both operands and
  // return, so the swap is a precedence change only.
  const nonCallableThrow = tryEmitNonCallableRhsThrow(ctx, fctx, expr);
  if (nonCallableThrow) return nonCallableThrow;

  if (noJsHost(ctx) && isExclusivelyPrimitiveType(ctx.checker.getTypeAtLocation(expr.left))) {
    const lt = compileExpression(ctx, fctx, expr.left);
    if (lt) fctx.body.push({ op: "drop" });
    const rt = compileExpression(ctx, fctx, expr.right);
    if (rt) fctx.body.push({ op: "drop" });
    fctx.body.push({ op: "i32.const", value: 0 });
    return { kind: "i32" };
  }

  // (#2916 Slice B) Host-free §13.10.2 + §7.3.20 for the fully-dynamic RHS.
  // Returns the SAME 0/1/2 tri-state `__instanceof_check` did, so the throw
  // guard below is reused unchanged. Declines (null) in gc/host mode — that lane
  // keeps the host predicate byte-identically. See native-dynamic-instanceof.ts
  // for the per-representation answer table and the documented residual (a
  // closure RHS has no runtime edge to its prototype object, so it answers
  // `false` rather than guessing).
  const nativeDynamic = tryEmitNativeDynamicInstanceOf(ctx, fctx, expr);
  if (nativeDynamic) {
    emitInstanceofThrowGuard(ctx, fctx);
    return nativeDynamic;
  }

  // (#2702) `__instanceof_check` implements §13.10.2 InstanceofOperator +
  // §7.3.20 OrdinaryHasInstance and returns a tri-state (0/1/2) so the
  // non-object / non-callable / custom-@@hasInstance cases are handled
  // spec-correctly (TypeError emitted from wasm via emitInstanceofThrowGuard).
  const instanceofIdx = ensureLateImport(
    ctx,
    "__instanceof_check",
    [{ kind: "externref" }, { kind: "externref" }],
    [{ kind: "i32" }],
  );
  flushLateImportShifts(ctx, fctx);

  const leftType = compileExpression(ctx, fctx, expr.left);
  if (!leftType) {
    fctx.body.push({ op: "ref.null.extern" });
  } else if (leftType.kind !== "externref") {
    coerceType(ctx, fctx, leftType, { kind: "externref" });
  }

  const rightType = compileExpression(ctx, fctx, expr.right);
  if (!rightType) {
    fctx.body.push({ op: "ref.null.extern" });
  } else if (rightType.kind !== "externref") {
    coerceType(ctx, fctx, rightType, { kind: "externref" });
  }

  if (instanceofIdx === undefined) {
    fctx.body.push({ op: "drop" });
    fctx.body.push({ op: "drop" });
    fctx.body.push({ op: "i32.const", value: 0 });
    return { kind: "i32" };
  }

  fctx.body.push({ op: "call", funcIdx: instanceofIdx });
  emitInstanceofThrowGuard(ctx, fctx);
  return { kind: "i32" };
}

/**
 * (#2916) Deduped root struct type indices of every registered closure wrapper,
 * for `ref.test`-discriminating a callable (Function membership). Mirrors the
 * private helper in `dyn-read.ts` / `index.ts` (walking each closure struct up
 * its `superTypeIdx` chain to the root) — inlined here to avoid a cross-module
 * import cycle. Type-index `ref.test` is rec-group / dead-elim stable, so this
 * carries no funcidx-shift hazard.
 */
function closureRootTypeIdxsFor(ctx: CodegenContext): number[] {
  const mod = ctx.mod;
  const out: number[] = [];
  const seen = new Set<number>();
  for (const [typeIdx, info] of ctx.closureInfoByTypeIdx) {
    if (!info) continue;
    const typeDef = mod.types[typeIdx];
    if (!typeDef || typeDef.kind !== "struct") continue;
    let root = typeIdx;
    let cur: typeof typeDef = typeDef;
    while (cur && cur.kind === "struct" && cur.superTypeIdx !== undefined && cur.superTypeIdx >= 0) {
      const parent = mod.types[cur.superTypeIdx];
      if (!parent || parent.kind !== "struct") break;
      root = cur.superTypeIdx;
      cur = parent;
    }
    if (!seen.has(root)) {
      seen.add(root);
      out.push(root);
    }
  }
  return out;
}

/**
 * (#2916) Backing-struct type indices answering `value instanceof <Builtin>`
 * natively via `ref.test`, for the `noJsHost` (standalone / WASI) string-name
 * path where the legacy `__instanceof` host import is unsatisfiable.
 *
 * Non-empty lists are unions; empty is false; undefined has no native model.
 *
 * SAFETY: this whole branch only runs under `noJsHost`, where the string-name
 * path currently *always* leaks `__instanceof` (→ the module cannot instantiate
 * standalone, so every reaching test already fails). A native answer can only
 * CONVERT a failing test, never regress a passing one; gc/host is byte-identical
 * (this branch is skipped there); and `ref.test` uses *type* indices, which are
 * rec-group / dead-elim stable (no funcidx-ordering hazard).
 *
 * Error-family RHS (`Error` / `*Error` / user Error subclasses) is handled by
 * the dedicated native branch above and never reaches here. Deliberately NOT
 * modeled in this first cut (Slice A): `Object` (needs a struct-minus-boxed
 * discriminator to avoid a wrong `true` on boxed primitives) and the reflective
 * fully-dynamic RHS path (`__instanceof_check`, Slice B) — both deferred.
 */
function nativeBuiltinInstanceOfTypeIdxs(ctx: CodegenContext, ctorName: string): number[] | undefined {
  const keep = (...idxs: (number | undefined)[]): number[] =>
    idxs.filter((n): n is number => typeof n === "number" && n >= 0);
  switch (ctorName) {
    case "Array": {
      // Every registered vec subtype (plain arrays, tuples). `vecBaseTypeIdx` is
      // the shared `$__vec_base` supertype, so `ref.test` against it matches all
      // vec subtypes in one op; union the concrete vec types as a fallback when
      // no base is registered. Imprecision note (carried from #2605/#2893):
      // TypedArray views currently share the `$Vec` representation with plain
      // arrays and have no distinguishing brand yet, so `typedArray instanceof
      // Array` may answer `true`. This is regression-safe (the reaching test
      // already fails to instantiate standalone) and never a wrong `true` on a
      // currently-passing test; the brand fix is tracked by #2893/#2872.
      const set = new Set<number>();
      if (ctx.vecBaseTypeIdx >= 0) set.add(ctx.vecBaseTypeIdx);
      for (const idx of ctx.vecTypeMap.values()) if (idx >= 0) set.add(idx);
      return [...set];
    }
    case "Function":
      // Any registered closure (IsCallable). #1992: a WasmGC closure IS an
      // `instanceof Function`.
      return closureRootTypeIdxsFor(ctx);
    case "Map":
    case "WeakMap":
    case "Set":
    case "WeakSet":
      // #2605: native collections share the `$Map` backing struct, so cross-type
      // assertions (`set instanceof Map`) are imprecise — carried forward, not a
      // regression.
      return keep(ctx.mapTypeIdx);
    case "Number":
      return keep(ctx.wrapperNumberTypeIdx);
    case "String":
      return keep(ctx.wrapperStringTypeIdx);
    case "Boolean":
      // NOT force-registered via `ensureWrapperTypes` — see the "Measured and
      // deliberately reverted" note in `native-object-family-instanceof.ts`.
      return keep(ctx.wrapperBooleanTypeIdx);
    case "Date":
      // (#1325) `new Date()` lowers to a distinct `$__Date` WasmGC struct
      // (one i64 timestamp field). Register-or-fetch its type idx so
      // `ref.test $__Date` answers `d instanceof Date` host-free even when the
      // LHS is `any` (the static `tryStaticInstanceOf` path already covers a
      // statically-typed `Date` LHS). `ensureDateStruct` is idempotent and
      // type-only (no funcidx shift), so calling it here is compile-order-safe.
      return keep(ensureDateStruct(ctx));
    case "RegExp":
      // (#1325) A RegExp literal / `new RegExp(...)` lowers to the distinct
      // `$__StandaloneRegExp` struct; `ref.test` against it answers
      // `r instanceof RegExp` host-free. Idempotent, type-only registration.
      return keep(ensureStandaloneRegExpStruct(ctx));
    case "Promise":
      // (#1325) A Promise lowers to the distinct `$Promise` struct
      // (state/value/callbacks). `ref.test` against it answers
      // `p instanceof Promise` host-free. `getOrRegisterPromiseType` is
      // idempotent and type-only (registers the struct type + scheduler state
      // bookkeeping; no funcidx shift), so calling it here is compile-order-safe.
      return keep(getOrRegisterPromiseType(ctx));
    default:
      return undefined;
  }
}

function isStandaloneWrapperConstructorName(ctorName: string): ctorName is StandaloneWrapperConstructorName {
  return ctorName === "Number" || ctorName === "String" || ctorName === "Boolean";
}

/** Emit the real standalone wrapper-brand predicate over the LHS carrier. */
function emitNativeWrapperInstanceOf(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.BinaryExpression,
  ctorName: StandaloneWrapperConstructorName,
): ValType {
  const helperIdx = ensureStandaloneWrapperInstanceOfHelper(ctx, ctorName);
  const leftType = compileExpression(ctx, fctx, expr.left);
  if (leftType && (leftType.kind === "i32" || leftType.kind === "f64" || leftType.kind === "i64")) {
    fctx.body.push({ op: "drop" });
    fctx.body.push({ op: "i32.const", value: 0 });
    return { kind: "i32" };
  }
  if (!leftType) {
    fctx.body.push({ op: "ref.null", typeIdx: -18 }); // none <: anyref
  } else if (leftType.kind === "externref") {
    fctx.body.push({ op: "any.convert_extern" });
  } else if (leftType.kind !== "anyref") {
    coerceType(ctx, fctx, leftType, { kind: "externref" });
    fctx.body.push({ op: "any.convert_extern" });
  }
  fctx.body.push({ op: "call", funcIdx: helperIdx });
  return { kind: "i32" };
}

/**
 * (#2916) Emit a native `value instanceof <Builtin>` membership test: normalize
 * the LHS to anyref and OR together `ref.test <typeIdx>` over `typeIdxs`. A
 * numeric/boolean primitive or null LHS answers `0` (never traps: `ref.test`
 * on a null / non-matching anyref is `0`). Leaves an i32 (0/1) on the stack.
 */
function emitNativeInstanceOfMembership(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.BinaryExpression,
  typeIdxs: number[],
): ValType {
  const leftType = compileExpression(ctx, fctx, expr.left);
  if (leftType && (leftType.kind === "i32" || leftType.kind === "f64" || leftType.kind === "i64")) {
    // A numeric / boolean primitive is never a builtin-object instance.
    fctx.body.push({ op: "drop" });
    fctx.body.push({ op: "i32.const", value: 0 });
    return { kind: "i32" };
  }
  if (!leftType) {
    fctx.body.push({ op: "ref.null.extern" });
  } else if (leftType.kind !== "externref") {
    coerceType(ctx, fctx, leftType, { kind: "externref" });
  }
  fctx.body.push({ op: "any.convert_extern" });
  const anyLocalIdx = allocLocal(fctx, `__io_any_${fctx.locals.length}`, { kind: "anyref" } as ValType);
  fctx.body.push({ op: "local.set", index: anyLocalIdx });
  if (typeIdxs.length === 0) {
    fctx.body.push({ op: "i32.const", value: 0 });
    return { kind: "i32" };
  }
  fctx.body.push({ op: "local.get", index: anyLocalIdx });
  fctx.body.push({ op: "ref.test", typeIdx: typeIdxs[0]! });
  for (let i = 1; i < typeIdxs.length; i++) {
    fctx.body.push({ op: "local.get", index: anyLocalIdx });
    fctx.body.push({ op: "ref.test", typeIdx: typeIdxs[i]! });
    fctx.body.push({ op: "i32.or" });
  }
  return { kind: "i32" };
}

/**
 * Compile `expr instanceof RHS` using a host import when the RHS class is not
 * in our struct system (e.g., TypeError, Array, Function, Promise). (#738)
 * Passes the value as externref and the constructor name as a string constant,
 * delegating to `__instanceof(value, ctorName) -> i32` host import which
 * looks up the constructor on the global object.
 *
 * For built-in RHS (Array, Error, *Error, Map, ...), tries `tryStaticInstanceOf`
 * first to short-circuit when the LHS TS type makes the answer compile-time
 * obvious — important for standalone/WASI mode (#1325).
 */
function compileHostInstanceOf(ctx: CodegenContext, fctx: FunctionContext, expr: ts.BinaryExpression): ValType {
  // (#2702) §13.10.2 step 1: a RHS that is statically and *exclusively* a
  // primitive / null / undefined — `x instanceof undefined`, `[] instanceof 1`,
  // an identifier of primitive type — can NEVER be a valid constructor, so the
  // operator throws a TypeError after evaluating both operands (§13.10.1). Emit
  // that throw unconditionally here rather than routing to the runtime host
  // check: the dynamic check is deliberately conservative about a *runtime*
  // `undefined`/`null` target (a `Function(...)` constructor result lowers to
  // `undefined` in our backend and must still answer `false`, not throw), so the
  // genuine "statically non-constructor RHS" case is distinguished in codegen
  // where the static type is visible. We require the type to be EXCLUSIVELY
  // primitive (no Object / Any / Unknown / TypeParameter members) so an
  // `any`-typed or `string | Ctor` RHS is never spuriously thrown on.
  {
    const rhsType = ctx.checker.getTypeAtLocation(expr.right);
    const PRIMITIVE_RHS =
      ts.TypeFlags.Undefined |
      ts.TypeFlags.Null |
      ts.TypeFlags.NumberLike |
      ts.TypeFlags.StringLike |
      ts.TypeFlags.BooleanLike |
      ts.TypeFlags.BigIntLike |
      ts.TypeFlags.ESSymbolLike;
    const NON_PRIMITIVE =
      ts.TypeFlags.Object |
      ts.TypeFlags.Any |
      ts.TypeFlags.Unknown |
      ts.TypeFlags.TypeParameter |
      ts.TypeFlags.NonPrimitive;
    // (#4484 A) …but the STATIC type of a REASSIGNED binding is not evidence
    // about its value at this site. `var OBJECT = 0; (OBJECT = Object, {})
    // instanceof OBJECT` widens `OBJECT` to `number` from its initializer, and
    // TS never narrows it back (the write is a type error that
    // `skipSemanticDiagnostics` suppresses). The fold then threw
    // "Right-hand side of 'instanceof' is not an object" for an RHS that holds
    // the real `Object` constructor at runtime — a WRONG throw, observable in a
    // `catch` (`S11.8.6_A2.4_T1`, measured fail→pass). Any write to the name
    // anywhere in the file disqualifies the static claim; the site then routes
    // to the runtime tri-state helper, which decides from the VALUE.
    const rhsIsReassignedBinding =
      ts.isIdentifier(expr.right) && identifierIsWrittenTo(expr.right.getSourceFile(), expr.right.text);
    if (!rhsIsReassignedBinding && (rhsType.flags & PRIMITIVE_RHS) !== 0 && (rhsType.flags & NON_PRIMITIVE) === 0) {
      // Evaluate LHS then RHS for side effects, discard both, then throw.
      const lt = compileExpression(ctx, fctx, expr.left);
      if (lt) fctx.body.push({ op: "drop" });
      const rt = compileExpression(ctx, fctx, expr.right);
      if (rt) fctx.body.push({ op: "drop" });
      emitThrowTypeError(ctx, fctx, "Right-hand side of 'instanceof' is not an object");
      return { kind: "i32" };
    }
  }

  // (#4484 A) §7.3.20 step 1 — a bare builtin NAMESPACE RHS (`Math`, `JSON`,
  // `Reflect`, `Atomics`) has no [[Call]], so the operator throws whatever the
  // LHS is. Placed here, ahead of `ctorName` resolution: `Math` resolves to a
  // name the builtin dispatch below folds statically (to `false`), so the
  // non-callable arm inside `emitDynamicInstanceOf` was never reached
  // (`S11.8.6_A6_T2`, measured fail→pass).
  {
    const namespaceThrow = tryEmitNonCallableRhsThrow(ctx, fctx, expr);
    if (namespaceThrow) return namespaceThrow;
  }

  // Resolve constructor name from the RHS expression (simple identifiers only)
  let ctorName: string | undefined;
  if (ts.isIdentifier(expr.right)) {
    ctorName = expr.right.text;
    // (#1455) Resolve anonymous class-expression aliases. `const Sub = class extends Map {}`
    // registers the class as a synthetic name like `__anonClass_N`; the
    // constructor tags instances with that synthetic name, so the host check
    // must compare against it (not the user-facing binding name).
    const mapped = ctx.classExprNameMap.get(ctorName);
    if (mapped !== undefined && ctx.classTagMap.has(mapped)) {
      ctorName = mapped;
    }
  }

  // (#2916) `var OBJECT = Object; x instanceof OBJECT` — resolve the builtin
  // behind an alias so the builtin dispatch below is not skipped (host-free
  // only; gc/host keeps its runtime predicate). See native-ordinary-instanceof.ts.
  ctorName = resolveBuiltinCtorAliasName(ctx, expr.right, ctorName) ?? ctorName;

  if (!ctorName) {
    return emitDynamicInstanceOf(ctx, fctx, expr);
  }

  // Static fast-path: try compile-time evaluation against the built-in
  // type-tag registry (#1325). When this resolves, we skip the host call.
  const staticResult = tryStaticInstanceOf(ctx, expr, ctorName);
  if (staticResult !== undefined) {
    return emitConstantInstanceOf(ctx, fctx, expr, staticResult);
  }

  const hostDate =
    ctorName === "Date" ? emitHostOrNativeBuiltinInstanceOf(ctx, fctx, expr, ctorName, [ensureDateStruct(ctx)]) : null;
  if (hostDate) return hostDate;

  // (#1536c) Standalone / WASI: `instance instanceof MyError` where
  // `class MyError extends Error {}` is an externref-backed user subclass. The
  // instance is the parent's `$Error_struct` (created natively by
  // `__new_<Parent>`, #1536c), so discriminate by the parent error's `$tag`
  // set — natively, no `__instanceof`/`__tag_user_class` host import. Run this
  // BEFORE the generic `emitDynamicInstanceOf` route below, which would emit a
  // host import. Precision note: this resolves `instanceof MyError` to "is an
  // Error-family struct compatible with MyError's builtin parent" — exact for a
  // single subclass; distinguishing sibling subclasses needs a per-user-class
  // brand (broader $ClassMeta work, #2101). Captured in #1536c's resolution.
  let userErrorParent: string | undefined;
  if (ctx.targetProfile.semanticProviders === "native-first" && !isBuiltinTypeName(ctorName)) {
    const bp = ctx.classBuiltinParentMap.get(ctorName);
    if (bp && (bp === "Error" || isWasiErrorName(bp))) userErrorParent = bp;
  }

  if (
    ts.isIdentifier(expr.right) &&
    !isBuiltinTypeName(ctorName) &&
    identifierHasSourceDeclaration(ctx, expr.right) &&
    userErrorParent === undefined
  ) {
    // (#3962) Host-free answer for a plain user function constructor — the
    // `e instanceof Test262Error` shape, 26 of the 36 ≤ES5 sole leaks of
    // `env::__instanceof_check`. Declines to null and leaves this path unchanged.
    const nativeCtor = noJsHost(ctx) ? tryEmitNativeUserCtorInstanceOf(ctx, fctx, expr, ctorName) : null;
    if (nativeCtor) return nativeCtor;
    return emitDynamicInstanceOf(ctx, fctx, expr);
  }

  // #1473 — no JS host: `e instanceof TypeError` (and other Error subtypes)
  // where the LHS is a dynamic value (any/externref). The caught value is the
  // `$Error_struct` externref produced by emitWasiErrorConstructor; discriminate
  // by reading its `$tag` field (fieldIdx 0) and comparing against the set of
  // tags compatible with `ctorName`. No `__instanceof` host import.
  // (#1536c) `userErrorParent` extends this to externref-backed user Error
  // subclasses.
  if (
    ctx.targetProfile.semanticProviders === "native-first" &&
    (ctorName === "Error" ||
      isWasiErrorName(ctorName) ||
      // (#3234) SuppressedError is not in WASI_ERROR_NAMES (its ctor arity/args
      // differ), but its native `$Error_struct` carries the SuppressedError tag,
      // so the field-0 tag check answers `instanceof SuppressedError` host-free.
      ctorName === "SuppressedError" ||
      userErrorParent !== undefined)
  ) {
    const structIdx = getOrRegisterErrorStructType(ctx);
    // (#2188) When the RHS is a *user* Error subclass, sibling subclasses share
    // the same builtin parent `$tag`, so the builtin-tag check (field 0) cannot
    // tell `(new A) instanceof B` from `instanceof A`. Instead read the
    // per-class brand (`$userClassId`, fieldIdx 4) written at the subclass
    // construction site and compare it against the set of class ids that count
    // as `instanceof ctorName`: ctorName's own id plus every user subclass that
    // (transitively) extends it. `Error`/`TypeError` (builtin RHS) keep the
    // field-0 tag check unchanged. The brand of a plain builtin Error is the
    // `-1` sentinel, which never appears in `brandIds` (ids are >= 0), so
    // `e instanceof MySubclass` is correctly false for a non-branded Error.
    const useBrand = userErrorParent !== undefined;
    const brandIds = useBrand ? collectUserErrorSubclassBrandIds(ctx, ctorName) : [];
    // A user subclass with no resolvable brand id (should not happen — every
    // class is in classTagMap) would make the test vacuously false; guard so we
    // never emit an empty compare set. Fall through to the host path if so.
    if (!useBrand || brandIds.length > 0) {
      const compatTags = useBrand ? brandIds : collectErrorInstanceOfTags(ctorName);
      const brandFieldIdx = useBrand ? 4 : 0;
      const leftType = compileExpression(ctx, fctx, expr.left);
      if (leftType && leftType.kind !== "externref") {
        // Numeric / boolean primitives are never Error instances.
        if (leftType.kind === "i32" || leftType.kind === "f64" || leftType.kind === "i64") {
          fctx.body.push({ op: "drop" });
          fctx.body.push({ op: "i32.const", value: 0 });
          return { kind: "i32" };
        }
        coerceType(ctx, fctx, leftType, { kind: "externref" });
      } else if (!leftType) {
        fctx.body.push({ op: "ref.null.extern" });
      }
      // externref -> anyref, store in temp, ref.test $Error_struct, then read
      // the discriminating field (builtin tag = field 0, user brand = field 4).
      fctx.body.push({ op: "any.convert_extern" });
      const anyLocalIdx = allocLocal(fctx, `__err_instanceof_${fctx.locals.length}`, { kind: "anyref" } as ValType);
      fctx.body.push({ op: "local.set", index: anyLocalIdx });
      const elseBody: Instr[] = [
        { op: "local.get", index: anyLocalIdx },
        { op: "ref.cast", typeIdx: structIdx },
        { op: "struct.get", typeIdx: structIdx, fieldIdx: brandFieldIdx },
      ];
      if (compatTags.length === 1) {
        elseBody.push({ op: "i32.const", value: compatTags[0]! });
        elseBody.push({ op: "i32.eq" });
      } else {
        const tagLocalIdx = allocLocal(fctx, `__err_tag_${fctx.locals.length}`, { kind: "i32" });
        elseBody.push({ op: "local.set", index: tagLocalIdx });
        elseBody.push({ op: "local.get", index: tagLocalIdx });
        elseBody.push({ op: "i32.const", value: compatTags[0]! });
        elseBody.push({ op: "i32.eq" });
        for (let i = 1; i < compatTags.length; i++) {
          elseBody.push({ op: "local.get", index: tagLocalIdx });
          elseBody.push({ op: "i32.const", value: compatTags[i]! });
          elseBody.push({ op: "i32.eq" });
          elseBody.push({ op: "i32.or" });
        }
      }
      fctx.body.push({ op: "local.get", index: anyLocalIdx });
      fctx.body.push({ op: "ref.test", typeIdx: structIdx });
      fctx.body.push({
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: elseBody,
        else: [{ op: "i32.const", value: 0 }],
      });
      return { kind: "i32" };
    }
  }

  // (#2916) No-JS-host: replace the unsatisfiable `__instanceof` host import on
  // the built-in string-name path with an inline native `ref.test` membership
  // test. This path currently ALWAYS leaks under standalone/WASI (→ the module
  // cannot instantiate, so every reaching test already fails), so a native
  // answer can only CONVERT a failing test — never regress a passing one; and
  // gc/host stays byte-identical (this branch is skipped when a JS host is
  // present). Error-family RHS was already handled natively above. A builtin we
  // do not yet model natively (Object, Promise, ArrayBuffer, DataView, typed
  // arrays, ...) or an unresolvable non-builtin ctor falls to a conservative `0`
  // (a missed conversion, never a wrong `true` — #2916). Date and RegExp ARE now
  // modeled (#1325, distinct $__Date / $__StandaloneRegExp structs). NEVER emit
  // the host import here.
  if (noJsHost(ctx)) {
    if (ctx.standalone && isStandaloneWrapperConstructorName(ctorName)) {
      return emitNativeWrapperInstanceOf(ctx, fctx, expr, ctorName);
    }
    const typeIdxs = nativeBuiltinInstanceOfTypeIdxs(ctx, ctorName);
    // `Object` and `Function` cannot be answered by a backing-struct membership
    // list — see `native-object-family-instanceof.ts` for why (no finite list /
    // snapshot-at-lowering-time). Route them through the finalize-corrected
    // `typeof` classifiers instead, OR-ing in the membership list so the answer
    // is never weaker than the one it replaces.
    if (isObjectFamilyCtorName(ctorName)) {
      const viaTypeof = tryEmitNativeObjectFamilyInstanceOf(ctx, fctx, expr, ctorName, typeIdxs);
      if (viaTypeof) return viaTypeof;
    }
    if (typeIdxs !== undefined) {
      return emitNativeInstanceOfMembership(ctx, fctx, expr, typeIdxs);
    }
    const lt = compileExpression(ctx, fctx, expr.left);
    if (lt) fctx.body.push({ op: "drop" });
    fctx.body.push({ op: "i32.const", value: 0 });
    return { kind: "i32" };
  }

  // Ensure the __instanceof host import exists
  const instanceofIdx = ensureLateImport(
    ctx,
    "__instanceof",
    [{ kind: "externref" }, { kind: "externref" }],
    [{ kind: "i32" }],
  );
  flushLateImportShifts(ctx, fctx);

  if (instanceofIdx === undefined) {
    const leftType = compileExpression(ctx, fctx, expr.left);
    if (leftType) fctx.body.push({ op: "drop" });
    fctx.body.push({ op: "i32.const", value: 0 });
    return { kind: "i32" };
  }

  // Compile left operand (the value to test)
  const leftType = compileExpression(ctx, fctx, expr.left);
  if (!leftType) {
    fctx.body.push({ op: "ref.null.extern" });
  } else if (leftType.kind === "i32" || leftType.kind === "f64") {
    // (#2702) §13.10.2 checks the RHS-is-an-object/callable condition (step 1/4,
    // which may throw a TypeError) BEFORE OrdinaryHasInstance looks at V. So the
    // "a primitive is never an instance → false" stack-level fast path is only
    // valid when the RHS is a KNOWN callable constructor (a builtin ctor or a
    // user class). For a RHS that resolves to a non-callable object
    // (`1 instanceof Math`) the spec requires a TypeError, so box the primitive
    // and let the host check return the throw sentinel (2). (The builtin +
    // statically-numeric-LHS case already short-circuited via
    // tryStaticInstanceOf, so reaching here with a builtin RHS means an
    // any-typed LHS — primitive → false is still correct there.)
    if (isBuiltinTypeName(ctorName) || ctx.classTagMap.has(ctorName)) {
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "i32.const", value: 0 });
      return { kind: "i32" };
    }
    coerceType(ctx, fctx, leftType, { kind: "externref" });
  } else if (leftType.kind !== "externref") {
    coerceType(ctx, fctx, leftType, { kind: "externref" });
  }

  // Push constructor name as a string constant. (#51) Materialize via the
  // dual-mode helper — under nativeStrings `addStringConstantGlobal` records a
  // `-1` sentinel global (no host string-constant global), so a bare
  // `global.get -1` reaches binary emit as "global index out of range — -1".
  // `stringConstantExternrefInstrs` emits the inline NativeString externref
  // standalone and the host `global.get` only when a real import global exists.
  addStringConstantGlobal(ctx, ctorName);
  fctx.body.push(...stringConstantExternrefInstrs(ctx, ctorName));

  // Call __instanceof(value, ctorName) -> i32 (tri-state: 0/1/2). (#2702) A
  // RHS that resolves to a non-callable object (`x instanceof Math`) returns 2,
  // which emitInstanceofThrowGuard turns into a spec-mandated wasm TypeError.
  fctx.body.push({ op: "call", funcIdx: instanceofIdx });
  emitInstanceofThrowGuard(ctx, fctx);
  return { kind: "i32" };
}

export { analyzeTdzAccessByPos, compileHostInstanceOf, compileIdentifier, narrowTypeToUnbox, resolveInstanceOfRHS };
