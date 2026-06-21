// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Shared utility helpers for expression sub-modules.
 *
 * Contains functions used by multiple expression sub-modules:
 *   - emitThrowString: emit a Wasm throw with a string message
 *   - isEffectivelyVoidReturn: check if a return type is void (incl. async)
 *   - getFuncParamTypes: look up Wasm param types for a function index
 *   - wasmFuncReturnsVoid / wasmFuncTypeReturnsVoid: void-return predicates
 *   - getWasmFuncReturnType: get the actual Wasm return type of a function
 */
import { ts } from "../../ts-api.js";
import { isVoidType, unwrapPromiseType } from "../../checker/type-mapper.js";
import type { Instr, ValType } from "../../ir/types.js";
import { getLocalType } from "../context/locals.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { stringConstantExternrefInstrs } from "../native-strings.js";
import { addStringConstantGlobal, ensureExnTag } from "../registry/imports.js";
import { emitWasiErrorConstructor } from "../registry/error-types.js";
import { coerceType, ensureLateImport, flushLateImportShifts, valTypesMatch } from "../shared.js";

/**
 * #1473 — No-JS-host predicate. Both `--target wasi` and `--target standalone`
 * run without a JS runtime, so neither can rely on host imports such as
 * `__throw_type_error` / `__new_TypeError` resolving to JS constructors. In
 * these modes the compiler emits Wasm-native Error constructors instead.
 */
export function noJsHost(ctx: CodegenContext): boolean {
  return ctx.wasi || ctx.standalone;
}

/**
 * Emit a Wasm throw instruction with a string error message.
 * This replaces `unreachable` traps so that JS try/catch (and assert.throws)
 * can catch the error instead of getting an uncatchable RuntimeError.
 */
export function emitThrowString(ctx: CodegenContext, fctx: FunctionContext, message: string): void {
  addStringConstantGlobal(ctx, message);
  fctx.body.push(...stringConstantExternrefInstrs(ctx, message));
  const tagIdx = ensureExnTag(ctx);
  fctx.body.push({ op: "throw", tagIdx });
}

/**
 * #1365 — Resolve the class struct that declared a `#name` PrivateIdentifier.
 *
 * Per ES2022 §15.7, a private name is lexically scoped to the class body that
 * declares it. To brand-check `obj.#x`, we need to know which class struct
 * to test the receiver against.
 *
 * Strategy: walk up `node.parent` from the PrivateIdentifier to find the
 * enclosing class declaration whose body declared `#x`. The TS parser
 * preserves `parent` links via `setParentNodes`. If multiple nested classes
 * each declare `#x`, the innermost wins (lexical shadowing — same as
 * regular variable scope).
 *
 * Returns `undefined` when:
 *   - The PrivateIdentifier isn't lexically inside any class (parser will
 *     have already caught this as a syntax error, but defensive).
 *   - The class hasn't been registered with a struct (e.g. external class,
 *     or compilation order issue).
 *
 * Returns the matched class's struct typeIdx and the legacy field name
 * (`__priv_<text>`) so the caller can emit `ref.test` / `ref.cast` /
 * `struct.get` against the right slot.
 */
export function resolveDeclaringClassForPrivateName(
  ctx: CodegenContext,
  node: ts.PrivateIdentifier,
): { className: string; structTypeIdx: number; fieldName: string } | undefined {
  const fieldName = "__priv_" + node.text.slice(1);
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if ((ts.isClassDeclaration(current) || ts.isClassExpression(current)) && current.name) {
      const className = current.name.text;
      const structFields = ctx.structFields.get(className);
      // Only return when this class actually declared the private name —
      // a nested class that doesn't declare `#x` shouldn't shadow the outer.
      if (structFields?.some((f) => f.name === fieldName)) {
        const structTypeIdx = ctx.structMap.get(className);
        if (structTypeIdx !== undefined) {
          return { className, structTypeIdx, fieldName };
        }
      }
    }
    current = current.parent;
  }
  return undefined;
}

function collectClassAndDescendantTags(ctx: CodegenContext, className: string): number[] {
  const tags: number[] = [];
  const ownTag = ctx.classTagMap.get(className);
  if (ownTag !== undefined) tags.push(ownTag);

  const queue = [className];
  const seen = new Set(queue);
  while (queue.length > 0) {
    const parent = queue.shift()!;
    for (const [child, childParent] of ctx.classParentMap) {
      if (childParent !== parent || seen.has(child)) continue;
      seen.add(child);
      queue.push(child);
      const tag = ctx.classTagMap.get(child);
      if (tag !== undefined) tags.push(tag);
    }
  }
  return tags;
}

/**
 * Emit the runtime private-brand predicate for a receiver saved as anyref.
 *
 * `ref.test $DeclaringClass` alone is not a full brand check in this compiler:
 * unrelated classes with identical private-field layout may canonicalize to the
 * same WasmGC shape. The hidden class tag distinguishes declarations, while
 * descendant tags remain valid for private names initialized by an ancestor.
 */
export function emitPrivateBrandPredicate(
  ctx: CodegenContext,
  fctx: FunctionContext,
  receiverLocal: number,
  className: string,
  structTypeIdx: number,
): void {
  const fields = ctx.structFields.get(className);
  const tagFieldIdx = fields?.findIndex((f) => f.name === "__tag") ?? -1;
  const allowedTags = collectClassAndDescendantTags(ctx, className);

  fctx.body.push({ op: "local.get", index: receiverLocal });
  fctx.body.push({ op: "ref.test", typeIdx: structTypeIdx } as Instr);

  if (tagFieldIdx < 0 || allowedTags.length === 0) {
    return;
  }

  const tagChecks: Instr[] = [];
  for (let i = 0; i < allowedTags.length; i++) {
    tagChecks.push({ op: "local.get", index: receiverLocal } as Instr);
    tagChecks.push({ op: "ref.cast", typeIdx: structTypeIdx } as Instr);
    tagChecks.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx: tagFieldIdx } as Instr);
    tagChecks.push({ op: "i32.const", value: allowedTags[i]! } as Instr);
    tagChecks.push({ op: "i32.eq" } as Instr);
    if (i > 0) {
      tagChecks.push({ op: "i32.or" } as Instr);
    }
  }

  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "i32" } },
    then: tagChecks,
    else: [{ op: "i32.const", value: 0 } as Instr],
  } as Instr);
}

/**
 * (#2102) Error constructors {@link emitThrowJsError} can build. Each maps to a
 * `__new_<Kind>(message)` host import in JS-host mode and to the in-module WASI
 * Error constructor under `--target standalone`/`wasi`. The set is the spec's
 * runtime-check error family (the §10/§22/§23 bounds/integrity/callable checks).
 */
export type JsErrorKind = "TypeError" | "RangeError" | "ReferenceError" | "SyntaxError" | "Error";

/**
 * (#2102) THE shared "throw a real JS Error instance" lowering. Runtime checks
 * (bounds / integrity / callable / [[Set]] failures) that the spec requires to
 * raise a catchable `TypeError`/`RangeError`/… must route through here instead
 * of emitting an uncatchable Wasm `unreachable`/`ref.cast` trap or a bare string
 * throw. The thrown ref is a real `<Kind>`-tagged externref (`e instanceof
 * <Kind>` holds), produced by the same `__new_<Kind>(message)` path `new
 * <Kind>(msg)` uses, and dispatched through the shared `$exc` tag so the user's
 * try/catch (and test262 `assert.throws`) catches it.
 *
 * Dual-mode: in no-JS-host mode (`--target standalone`/`wasi`) the constructor
 * is the in-module `emitWasiErrorConstructor` function, so no unsatisfiable
 * `env::__new_<Kind>` host import is requested. The constructor is registered
 * BEFORE the funcIdx is resolved so `ensureLateImport` finds the in-module
 * function in funcMap and does NOT add an `env::__new_<Kind>` host import.
 * (Consolidates the previously-duplicated #1365 TypeError / #1473
 * ReferenceError / #2164 RangeError lowerings.)
 *
 * Leaves nothing on the value stack (the `throw` is terminal / stack-polymorphic).
 */
export function emitThrowJsError(ctx: CodegenContext, fctx: FunctionContext, kind: JsErrorKind, message: string): void {
  if (noJsHost(ctx)) {
    emitWasiErrorConstructor(ctx, kind, 1);
  }
  addStringConstantGlobal(ctx, message);
  fctx.body.push(...stringConstantExternrefInstrs(ctx, message));
  const ctorIdx = ensureLateImport(ctx, `__new_${kind}`, [{ kind: "externref" }], [{ kind: "externref" }]);
  flushLateImportShifts(ctx, fctx);
  if (ctorIdx !== undefined) {
    fctx.body.push({ op: "call", funcIdx: ctorIdx });
  }
  // If the constructor isn't available, the message externref is still on the
  // stack — degrade to throwing a string. Both paths produce the same tag.
  const tagIdx = ensureExnTag(ctx);
  fctx.body.push({ op: "throw", tagIdx });
}

/**
 * #1365 — Emit a Wasm throw of a real TypeError INSTANCE (not a bare string).
 * Thin wrapper over {@link emitThrowJsError}; retained as the canonical call
 * site name (many uses). Required for spec-compliant `assert.throws(TypeError,
 * fn)` test262 cases — those check `e instanceof TypeError` on the caught value.
 */
export function emitThrowTypeError(ctx: CodegenContext, fctx: FunctionContext, message: string): void {
  emitThrowJsError(ctx, fctx, "TypeError", message);
}

/**
 * #1473 — Emit a throw of a ReferenceError INSTANCE for TDZ / unresolved
 * identifier references. Mirrors `emitThrowTypeError`.
 *
 * In no-JS-host mode (`--target wasi` / `--target standalone`), the
 * ReferenceError is built via the in-module `__new_ReferenceError` function
 * (emitted by `emitWasiErrorConstructor`), so no `env::__new_ReferenceError`
 * host import is required. In JS-host mode the same import name resolves to
 * the JS `ReferenceError` constructor.
 *
 * Either way the throw is observable in the user's catch block via the
 * shared `$exc` tag, and `e instanceof ReferenceError` works through the
 * `$Error_struct` `$tag` field discrimination.
 */
export function emitThrowReferenceError(ctx: CodegenContext, fctx: FunctionContext, message: string): void {
  // (#2102) Delegates to the shared lowering — see emitThrowJsError.
  emitThrowJsError(ctx, fctx, "ReferenceError", message);
}

/**
 * #2164 — Emit a throw of a RangeError INSTANCE. Mirrors `emitThrowTypeError`.
 * Used by `Date.prototype.toISOString` on an Invalid Date receiver
 * (ECMA-262 §21.4.4.36 — RangeError "Invalid time value"). In no-JS-host mode
 * the RangeError is built via the in-module `__new_RangeError` constructor; in
 * JS-host mode the import resolves to the JS `RangeError`.
 */
export function emitThrowRangeError(ctx: CodegenContext, fctx: FunctionContext, message: string): void {
  // (#2102) Delegates to the shared lowering — see emitThrowJsError.
  emitThrowJsError(ctx, fctx, "RangeError", message);
}

/**
 * #1456 — Classify a private property reference for assignment/compound-assignment.
 *
 * Per ES2022 §7.3.18 (PrivateElementSet) and §13.15.2
 * (AssignmentExpression : LHS op= AssignmentExpression):
 *
 *   - Private *methods* throw TypeError on any write (`=`, `+=`, …).
 *   - Private *accessor* with no setter throws TypeError on write.
 *   - Private *accessor* with no getter throws TypeError on read (matters
 *     for compound: the read step happens first).
 *   - Plain private fields read/write through the brand slot as usual.
 *
 * We classify the LHS at compile time by looking up the brand-table proxies
 * we've already populated when the class was registered:
 *   - `ctx.classMethodSet` — `<Class>_<__priv_name>` for private methods
 *     (both static and instance share the same `__priv_X` name space; that's
 *     consistent with how `resolveClassMemberName` mangles them).
 *   - `ctx.classAccessorSet` — `<Class>_<__priv_name>` for accessors;
 *     existence of `<Class>_get_<__priv_name>` / `<Class>_set_<__priv_name>`
 *     in `ctx.funcMap` distinguishes getter-only / setter-only / pair.
 *
 * Returns `undefined` if the receiver class cannot be resolved (defensive —
 * the caller falls back to existing behavior).
 */
export type PrivateMemberKind = "method" | "accessor-readonly" | "accessor-writeonly" | "accessor" | "field";

export function classifyPrivateMember(
  ctx: CodegenContext,
  name: ts.PrivateIdentifier,
): { className: string; fieldName: string; kind: PrivateMemberKind } | undefined {
  const fieldName = "__priv_" + name.text.slice(1);
  // Walk up parent links to find the lexically enclosing class that declares `#name`.
  // Unlike resolveDeclaringClassForPrivateName, we need to consider classes whose
  // PrivateIdentifier was registered as a method or accessor — those entries do
  // NOT appear in ctx.structFields, so the field-only lookup fails. We probe each
  // of method / accessor / field sets in turn.
  let current: ts.Node | undefined = name.parent;
  while (current) {
    if ((ts.isClassDeclaration(current) || ts.isClassExpression(current)) && current.name) {
      const className = current.name.text;
      const fullName = `${className}_${fieldName}`;
      // Method: registered in classMethodSet (instance) or staticMethodSet (static).
      if (ctx.classMethodSet.has(fullName) || ctx.staticMethodSet.has(fullName)) {
        return { className, fieldName, kind: "method" };
      }
      // Accessor: classAccessorSet has the accessor key.
      if (ctx.classAccessorSet.has(fullName)) {
        const hasGetter = ctx.funcMap.has(`${className}_get_${fieldName}`);
        const hasSetter = ctx.funcMap.has(`${className}_set_${fieldName}`);
        if (hasGetter && !hasSetter) return { className, fieldName, kind: "accessor-readonly" };
        if (hasSetter && !hasGetter) return { className, fieldName, kind: "accessor-writeonly" };
        return { className, fieldName, kind: "accessor" };
      }
      // Field: declared as a struct field on this class.
      const structFields = ctx.structFields.get(className);
      if (structFields?.some((f) => f.name === fieldName)) {
        return { className, fieldName, kind: "field" };
      }
    }
    current = current.parent;
  }
  return undefined;
}

/**
 * Check if a TS return type is effectively void for Wasm purposes.
 * For async functions, the TS checker reports `Promise<void>` which is not
 * caught by `isVoidType`. This helper unwraps Promise types for async
 * functions before checking.
 *
 * Use this instead of bare `isVoidType(retType)` at all call-return-type
 * resolution points to prevent emitting `drop` on an empty stack.
 */
export function isEffectivelyVoidReturn(ctx: CodegenContext, retType: ts.Type, funcName?: string): boolean {
  if (isVoidType(retType)) return true;
  // For async functions, unwrap Promise<T> and check if T is void
  if (funcName && ctx.asyncFunctions.has(funcName)) {
    const unwrapped = unwrapPromiseType(retType, ctx.checker);
    if (isVoidType(unwrapped)) return true;
  }
  return false;
}

/**
 * Get parameter types of a Wasm function by its index.
 * Handles both imported functions (index < numImportFuncs) and local functions.
 */
export function getFuncParamTypes(ctx: CodegenContext, funcIdx: number): ValType[] | undefined {
  if (funcIdx < ctx.numImportFuncs) {
    let importFuncCount = 0;
    for (const imp of ctx.mod.imports) {
      if (imp.desc.kind === "func") {
        if (importFuncCount === funcIdx) {
          const typeDef = ctx.mod.types[imp.desc.typeIdx];
          if (typeDef?.kind === "func") return typeDef.params;
          return undefined;
        }
        importFuncCount++;
      }
    }
  } else {
    const localIdx = funcIdx - ctx.numImportFuncs;
    const func = ctx.mod.functions[localIdx];
    if (func) {
      const typeDef = ctx.mod.types[func.typeIdx];
      if (typeDef?.kind === "func") return typeDef.params;
    }
  }
  return undefined;
}

/**
 * Check if a Wasm function (by index) has a void return type by inspecting
 * the actual function type in the module. This is the ground truth for whether
 * a `call` instruction pushes a value onto the stack.
 */
export function wasmFuncReturnsVoid(ctx: CodegenContext, funcIdx: number): boolean {
  if (funcIdx < ctx.numImportFuncs) {
    let importFuncCount = 0;
    for (const imp of ctx.mod.imports) {
      if (imp.desc.kind === "func") {
        if (importFuncCount === funcIdx) {
          const typeDef = ctx.mod.types[imp.desc.typeIdx];
          return !typeDef || typeDef.kind !== "func" || typeDef.results.length === 0;
        }
        importFuncCount++;
      }
    }
    return true; // not found — assume void to be safe
  }
  const localIdx = funcIdx - ctx.numImportFuncs;
  const func = ctx.mod.functions[localIdx];
  if (func) {
    const typeDef = ctx.mod.types[func.typeIdx];
    return !typeDef || typeDef.kind !== "func" || typeDef.results.length === 0;
  }
  return true; // not found — assume void to be safe
}

/** Check whether a function *type* (by type index) has zero results. */
export function wasmFuncTypeReturnsVoid(ctx: CodegenContext, typeIdx: number): boolean {
  const typeDef = ctx.mod.types[typeIdx];
  return !typeDef || typeDef.kind !== "func" || typeDef.results.length === 0;
}

/**
 * Get the actual Wasm return type of a function by inspecting its type definition.
 * Returns undefined if the function has void return or is not found.
 * Use this instead of resolveWasmType(retType) at call sites to avoid mismatches
 * when TS type says 'any' (→ externref) but the Wasm function returns f64/i32.
 */
export function getWasmFuncReturnType(ctx: CodegenContext, funcIdx: number): ValType | undefined {
  if (funcIdx < ctx.numImportFuncs) {
    let importFuncCount = 0;
    for (const imp of ctx.mod.imports) {
      if (imp.desc.kind === "func") {
        if (importFuncCount === funcIdx) {
          const typeDef = ctx.mod.types[imp.desc.typeIdx];
          if (typeDef?.kind === "func" && typeDef.results.length > 0) {
            return typeDef.results[0]!;
          }
          return undefined;
        }
        importFuncCount++;
      }
    }
    return undefined;
  }
  const localIdx = funcIdx - ctx.numImportFuncs;
  const func = ctx.mod.functions[localIdx];
  if (func) {
    const typeDef = ctx.mod.types[func.typeIdx];
    if (typeDef?.kind === "func" && typeDef.results.length > 0) {
      return typeDef.results[0]!;
    }
  }
  return undefined;
}

/**
 * Update a local's declared type to a new type.
 * Used when a variable is reassigned to a value of a different struct type.
 */
export function updateLocalType(fctx: FunctionContext, localIdx: number, newType: ValType): void {
  if (localIdx < fctx.params.length) {
    const param = fctx.params[localIdx];
    if (param) param.type = newType;
  } else {
    const local = fctx.locals[localIdx - fctx.params.length];
    if (local) local.type = newType;
  }
}

/**
 * Widen a local's declared type from ref $X to ref_null $X.
 */
export function widenLocalToNullable(fctx: FunctionContext, localIdx: number): void {
  if (localIdx < fctx.params.length) {
    const param = fctx.params[localIdx];
    if (param && param.type.kind === "ref") {
      param.type = { kind: "ref_null", typeIdx: (param.type as { typeIdx: number }).typeIdx };
    }
  } else {
    const local = fctx.locals[localIdx - fctx.params.length];
    if (local && local.type.kind === "ref") {
      local.type = { kind: "ref_null", typeIdx: (local.type as { typeIdx: number }).typeIdx };
    }
  }
}

/**
 * Emit a local.set with automatic type coercion.
 * If the value on the stack (stackType) doesn't match the local's declared type,
 * inserts coercion instructions before the local.set.
 */
export function emitCoercedLocalSet(
  ctx: CodegenContext,
  fctx: FunctionContext,
  localIdx: number,
  stackType: ValType,
): void {
  const localType = getLocalType(fctx, localIdx);
  if (localType && !valTypesMatch(stackType, localType)) {
    const sameRefTypeIdx =
      (stackType.kind === "ref" || stackType.kind === "ref_null") &&
      (localType.kind === "ref" || localType.kind === "ref_null") &&
      (stackType as { typeIdx: number }).typeIdx === (localType as { typeIdx: number }).typeIdx;
    if (sameRefTypeIdx && stackType.kind === "ref_null" && localType.kind === "ref") {
      widenLocalToNullable(fctx, localIdx);
    } else if (sameRefTypeIdx) {
      // ref -> ref_null: subtype, no coercion needed
    } else if (
      (stackType.kind === "ref" || stackType.kind === "ref_null") &&
      (localType.kind === "ref" || localType.kind === "ref_null")
    ) {
      const bodyLenBefore = fctx.body.length;
      coerceType(ctx, fctx, stackType, localType);
      if (fctx.body.length === bodyLenBefore) {
        updateLocalType(fctx, localIdx, stackType);
      }
    } else {
      coerceType(ctx, fctx, stackType, localType);
    }
  }
  fctx.body.push({ op: "local.set", index: localIdx });
}
