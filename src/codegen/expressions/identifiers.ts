// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Identifier resolution, TDZ analysis, and instanceof handling.
 */
import { ts, forEachChild } from "../../ts-api.js";
import {
  getNullablePrimitiveInfo,
  isBigIntType,
  isBooleanType,
  isHeterogeneousUnion,
  isNumberType,
  isStringType,
  type NullablePrimitiveInfo,
  type NullablePrimitiveKind,
} from "../../checker/type-mapper.js";
import type { Instr, ValType } from "../../ir/types.js";
import { emitCachedFuncClosureAccess, emitFuncRefAsClosure } from "../closures.js";
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
import { emitNullGuardedStructGet } from "../property-access.js";
import { coerceType, compileExpression } from "../shared.js";
import { emitTdzCheck } from "../statements.js";
import { ensureLateImport, flushLateImportShifts, shiftLateImportIndices } from "./late-imports.js";
import { emitStringBuilderRead, getBuilderInfo } from "../string-builder.js";
import { BUILTIN_TYPE_TAGS, isBuiltinSubtype, isBuiltinTypeName } from "../builtin-tags.js";
import { getOrRegisterErrorStructType, isWasiErrorName } from "../registry/error-types.js";
import { allocLocal } from "../context/locals.js";
import { reportSilentFallback } from "../fallback-telemetry.js";
import { emitThrowReferenceError, noJsHost } from "./helpers.js";
import { emitWithBindingGet, findWithBinding } from "../with-scope.js";
import { emitBuiltinNamespaceObject, isSupportedBuiltinNamespace } from "../builtin-static-globals.js";

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
  ] as const;
  const tags: number[] = [];
  for (const n of errorNames) {
    if (isBuiltinSubtype(n, ctorName)) {
      tags.push(BUILTIN_TYPE_TAGS[n]);
    }
  }
  return tags;
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
      fctx.body.push({ op: "struct.get", typeIdx: boxed.refCellTypeIdx, fieldIdx: 0 } as Instr);
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
    fctx.body.push({ op: "struct.get", typeIdx: boxed.refCellTypeIdx, fieldIdx: 0 } as Instr);
  } else {
    fctx.body.push({ op: "local.get", index: flagIdx });
  }
  fctx.body.push({ op: "i32.eqz" });
  let then: Instr[];
  if (throwRefErrIdx !== undefined) {
    addStringConstantGlobal(ctx, msg);
    const strIdx = ctx.stringGlobalMap.get(msg)!;
    then = [
      { op: "global.get", index: strIdx } as Instr,
      { op: "call", funcIdx: throwRefErrIdx } as Instr,
      { op: "unreachable" },
    ];
  } else {
    const tagIdx = ensureExnTag(ctx);
    then = [{ op: "ref.null.extern" } as Instr, { op: "throw", tagIdx }];
  }
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then,
    else: [],
  });
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
  const symbol = ctx.checker.getSymbolAtLocation(id);
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
  const symbol = ctx.checker.getSymbolAtLocation(id);
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
    fctx.body.push({ op: "global.get", index: strIdx } as Instr);
    fctx.body.push({ op: "call", funcIdx: throwRefErrIdx } as Instr);
    fctx.body.push({ op: "unreachable" });
    return;
  }
  const tagIdx = ensureExnTag(ctx);
  fctx.body.push({ op: "ref.null.extern" } as Instr);
  fctx.body.push({ op: "throw", tagIdx });
}

function compileIdentifier(ctx: CodegenContext, fctx: FunctionContext, id: ts.Identifier): ValType | null {
  const name = id.text;

  const withBinding = findWithBinding(fctx, name);
  if (withBinding) {
    return emitWithBindingGet(fctx, withBinding);
  }

  // #1210: string-builder bindings are stored as a (buf, len, cap, mat)
  // tuple of synthetic locals. The binding name is intentionally NOT in
  // `localMap` — read access materializes a NativeString lazily and caches
  // it in `mat`. Check this before the normal local lookup.
  const sb = getBuilderInfo(fctx, name);
  if (sb !== undefined) {
    return emitStringBuilderRead(ctx, fctx, sb);
  }

  const localIdx = fctx.localMap.get(name);
  if (localIdx !== undefined) {
    // TDZ check for function-local let/const variables
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
    if (declaredType.kind === "externref") {
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

    // Null narrowing: if this variable is known non-null (e.g. inside `if (x !== null)`),
    // emit ref.as_non_null and return ref instead of ref_null to skip downstream null guards.
    if (declaredType.kind === "ref_null" && fctx.narrowedNonNull?.has(name)) {
      fctx.body.push({ op: "ref.as_non_null" });
      return { kind: "ref", typeIdx: (declaredType as any).typeIdx };
    }

    return declaredType;
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

  // Standalone built-in namespace values (Array/Object) materialize as lazy
  // open-object singletons before ambient lib declarations can route them to
  // host globals.
  if (ctx.standalone && isSupportedBuiltinNamespace(name)) {
    const builtinObject = emitBuiltinNamespaceObject(ctx, fctx, name);
    if (builtinObject) return builtinObject;
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

  // globalThis — return the JS global object via host import
  if (name === "globalThis") {
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
  if (
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
        fctx.body.push({ op: "global.get", index: strGlobalIdx } as Instr);
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
  if (
    funcRefIdx !== undefined &&
    funcRefIdx >= ctx.numImportFuncs &&
    !name.startsWith("__") &&
    !ctx.classSet.has(name)
  ) {
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
      const cachedRefType = emitCachedFuncClosureAccess(ctx, fctx, name, funcRefIdx);
      if (cachedRefType) {
        return cachedRefType;
      }
    }
    // Fallback: per-site closure struct (with captures, or if cache emit failed).
    const refType = emitFuncRefAsClosure(ctx, fctx, name, funcRefIdx);
    if (refType) return refType;
  }

  // Check if this is a truly undeclared variable (no TS symbol).
  // Accessing an undeclared variable should throw ReferenceError per JS strict mode
  // (spec §13.10.1 / §13.11.4 — operand evaluation precedes ToPrimitive in `==`).
  // However, known globals (Symbol, Object, Reflect, etc.) have TS symbols from
  // lib.d.ts and should use the fallback default instead.
  const sym = ctx.checker.getSymbolAtLocation(id);
  if (!sym) {
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
      fctx.body.push({ op: "global.get", index: strIdx } as Instr);
      fctx.body.push({ op: "call", funcIdx: throwRefErrIdx } as Instr);
      fctx.body.push({ op: "unreachable" });
    } else {
      // Fallback: raw exception-tag throw (no JS host to construct a ReferenceError).
      const tagIdx = ensureExnTag(ctx);
      fctx.body.push({ op: "ref.null.extern" } as Instr);
      fctx.body.push({ op: "throw", tagIdx });
    }
    return { kind: "externref" };
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
  const symbol = ctx.checker.getSymbolAtLocation(id);
  const declarations = symbol?.declarations ?? [];
  return declarations.some((decl) => !decl.getSourceFile().isDeclarationFile);
}

function emitDynamicInstanceOf(ctx: CodegenContext, fctx: FunctionContext, expr: ts.BinaryExpression): ValType {
  const instanceofIdx = ensureLateImport(
    ctx,
    "__instanceof_dyn",
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

  if (!ctorName) {
    return emitDynamicInstanceOf(ctx, fctx, expr);
  }

  // Static fast-path: try compile-time evaluation against the built-in
  // type-tag registry (#1325). When this resolves, we skip the host call.
  const staticResult = tryStaticInstanceOf(ctx, expr, ctorName);
  if (staticResult !== undefined) {
    return emitConstantInstanceOf(ctx, fctx, expr, staticResult);
  }

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
  if (noJsHost(ctx) && !isBuiltinTypeName(ctorName)) {
    const bp = ctx.classBuiltinParentMap.get(ctorName);
    if (bp && (bp === "Error" || isWasiErrorName(bp))) userErrorParent = bp;
  }

  if (
    ts.isIdentifier(expr.right) &&
    !isBuiltinTypeName(ctorName) &&
    identifierHasSourceDeclaration(ctx, expr.right) &&
    userErrorParent === undefined
  ) {
    return emitDynamicInstanceOf(ctx, fctx, expr);
  }

  // #1473 — no JS host: `e instanceof TypeError` (and other Error subtypes)
  // where the LHS is a dynamic value (any/externref). The caught value is the
  // `$Error_struct` externref produced by emitWasiErrorConstructor; discriminate
  // by reading its `$tag` field (fieldIdx 0) and comparing against the set of
  // tags compatible with `ctorName`. No `__instanceof` host import.
  // (#1536c) `userErrorParent` extends this to externref-backed user Error
  // subclasses: discriminate against the *parent* error's compatible tag set.
  if (noJsHost(ctx) && (ctorName === "Error" || isWasiErrorName(ctorName) || userErrorParent !== undefined)) {
    const compatTags = collectErrorInstanceOfTags(userErrorParent ?? ctorName);
    const structIdx = getOrRegisterErrorStructType(ctx);
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
    // externref -> anyref, store in temp, ref.test $Error_struct, then read tag.
    fctx.body.push({ op: "any.convert_extern" } as Instr);
    const anyLocalIdx = allocLocal(fctx, `__err_instanceof_${fctx.locals.length}`, { kind: "anyref" } as ValType);
    fctx.body.push({ op: "local.set", index: anyLocalIdx });
    const elseBody: Instr[] = [
      { op: "local.get", index: anyLocalIdx },
      { op: "ref.cast", typeIdx: structIdx } as Instr,
      { op: "struct.get", typeIdx: structIdx, fieldIdx: 0 } as Instr,
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
    fctx.body.push({ op: "ref.test", typeIdx: structIdx } as Instr);
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: elseBody,
      else: [{ op: "i32.const", value: 0 }],
    });
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
    // Stack-level fast path: a primitive numeric value is never an instance of
    // any constructor — drop and emit false. (Avoids a host call + boxing.)
    fctx.body.push({ op: "drop" });
    fctx.body.push({ op: "i32.const", value: 0 });
    return { kind: "i32" };
  } else if (leftType.kind !== "externref") {
    coerceType(ctx, fctx, leftType, { kind: "externref" });
  }

  // Push constructor name as a string constant
  addStringConstantGlobal(ctx, ctorName);
  const strGlobalIdx = ctx.stringGlobalMap.get(ctorName);
  if (strGlobalIdx !== undefined) {
    fctx.body.push({ op: "global.get", index: strGlobalIdx });
  } else {
    fctx.body.push({ op: "ref.null.extern" });
  }

  // Call __instanceof(value, ctorName) -> i32
  fctx.body.push({ op: "call", funcIdx: instanceofIdx });
  return { kind: "i32" };
}

export { analyzeTdzAccessByPos, compileHostInstanceOf, compileIdentifier, narrowTypeToUnbox, resolveInstanceOfRHS };
