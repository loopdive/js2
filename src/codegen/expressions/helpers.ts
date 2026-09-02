// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Shared utility helpers for expression sub-modules.
 *
 * Contains functions used by multiple expression sub-modules:
 *   - isEffectivelyVoidReturn: check if a return type is void (incl. async)
 *   - getFuncParamTypes: look up Wasm param types for a function index
 *   - wasmFuncReturnsVoid / wasmFuncTypeReturnsVoid: void-return predicates
 *   - getWasmFuncReturnType: get the actual Wasm return type of a function
 */
import { ts } from "../../ts-api.js";
import { isVoidType, unwrapPromiseType } from "../../checker/type-mapper.js";
import type { Instr, ValType } from "../../ir/types.js";
import { classMemberFuncKey } from "../class-member-keys.js";
import { exactClassExpressionTypeName } from "../class-expression-identity.js";
import { allocLocal, getLocalType } from "../context/locals.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { funcSignatureOf } from "../func-space.js";
import { stringConstantExternrefInstrs } from "../native-strings.js";
import { addStringConstantGlobal } from "../registry/imports.js";
import { coerceType, compileExpression, valTypesMatch } from "../shared.js";
import { ensureLateImport, flushLateImportShifts } from "./late-imports.js";
export { tryCompileCallableStaticField } from "./static-callable-field.js";

// (#3191 — bloat S1) The JS-error-throw lowering was hoisted into the
// layering-safe leaf module `../js-errors.ts` so runtime modules (dataview-
// native / native-proto / array-methods / …) can share it without importing
// from `expressions/` (#3029). Imported here (some are used internally) AND
// re-exported so existing front-end importers keep resolving through
// `expressions/helpers.js` unchanged.
import {
  buildThrowJsErrorInstrs,
  emitThrowJsError,
  emitThrowRangeError,
  emitThrowReferenceError,
  emitThrowTypeError,
  noJsHost,
  usesNativeJsErrors,
} from "../js-errors.js";
export {
  buildThrowJsErrorInstrs,
  emitThrowJsError,
  emitThrowRangeError,
  emitThrowReferenceError,
  emitThrowTypeError,
  noJsHost,
  usesNativeJsErrors,
};
export type { JsErrorKind } from "../js-errors.js";

/**
 * (#5195 Step 9 I) True when `id` sits inside one of `decl`'s own class
 * elements — a method/accessor/field/static-block body, a parameter default,
 * or a computed key — rather than in its name or heritage clause. That is
 * exactly the region §15.7.14 step 3's immutable inner binding covers.
 *
 * A nested class or function inside a member body is still inside the outer
 * class's element, and the binding is still visible there, so the walk does not
 * stop at function boundaries. A same-named inner class SHADOWS the binding,
 * but then the oracle resolves `id` to that inner declaration instead and this
 * predicate is asked about the inner one.
 */
function writeIsInsideOwnClassBody(decl: ts.ClassLikeDeclaration, id: ts.Identifier): boolean {
  for (let node: ts.Node | undefined = id.parent; node !== undefined; node = node.parent) {
    if (node === decl) return false; // reached the class without passing an element
    if (node.parent === decl) return decl.members.indexOf(node as ts.ClassElement) >= 0;
  }
  return false;
}

/**
 * Whether this exact identifier reference resolves to a const binding.
 *
 * `constBindings` models currently-active local scopes, while the oracle is
 * necessary for a module lexical whose declaration was emitted by an earlier
 * physical module-init helper.  Keep both halves together: a name-only carry
 * between helpers would confuse an unrelated later binding with the same text.
 */
export function isConstIdentifierAssignmentTarget(
  ctx: CodegenContext,
  fctx: FunctionContext,
  id: ts.Identifier,
): boolean {
  // The oracle is authoritative when it resolves the reference: an active
  // same-text local set can belong to a different static block / namespace
  // binding and must not override that identity. Its `variableDeclarationOf`
  // intentionally declines destructured bindings, so walk a resolved
  // BindingElement through its binding pattern to the owning declaration.
  const declaration = ctx.oracle.valueDeclarationOf(id);
  if (declaration !== undefined) {
    // (#5195 Step 9 I) §15.7.14 step 3: ClassDefinitionEvaluation creates a
    // second, IMMUTABLE binding of the class name inside the class body's own
    // scope. `class C { m() { C = 42; } }` must therefore TypeError, while the
    // OUTER binding stays an ordinary mutable `let`-like one — `class C {};
    // C = 42;` is legal. The discriminator is purely lexical: the write is
    // inside one of this declaration's own elements.
    if (
      (ts.isClassDeclaration(declaration) || ts.isClassExpression(declaration)) &&
      writeIsInsideOwnClassBody(declaration, id)
    ) {
      return true;
    }
    let current: ts.Node | undefined = declaration;
    while (current !== undefined && !ts.isVariableDeclaration(current)) {
      if (!ts.isBindingElement(current) && !ts.isObjectBindingPattern(current) && !ts.isArrayBindingPattern(current)) {
        return false;
      }
      current = current.parent;
    }
    return (
      current !== undefined &&
      ts.isVariableDeclarationList(current.parent) &&
      (current.parent.flags & ts.NodeFlags.Const) !== 0
    );
  }
  return fctx.constBindings?.has(id.text) === true;
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
    if (ts.isClassDeclaration(current) || ts.isClassExpression(current)) {
      // The declaring class is the nearest lexically-enclosing class that
      // declares this private name in its OWN body (ES2022 §8.2.7: a private
      // name is bound in the class's PrivateEnvironment). Match on the class's
      // own member list — NOT `structFields`, which folds in fields INHERITED
      // through `extends`. A subclass that inherits `#x` (`class extends Outer {
      // f(){ return self.#x } }`) must NOT claim to declare it: resolving there
      // would brand-check the receiver against the SUBCLASS struct, so a genuine
      // `Outer` instance (`self`) fails `ref.test $Sub` and wrongly throws
      // TypeError (regressed `privatefieldget-success-1`). The walk skips such a
      // subclass and continues to the real declarer, `Outer`.
      const declaresOwn = current.members.some(
        (m) => m.name !== undefined && ts.isPrivateIdentifier(m.name) && m.name.text === node.text,
      );
      if (declaresOwn) {
        // Resolve the class's registered name. A NAMED class uses its AST name;
        // an ANONYMOUS class expression (`class { #m }` / `static B = class { #m }`)
        // has no `current.name`, so its members are keyed under the synthetic
        // `__anonClass_N` id assigned during collection. Without this fallback
        // the walk skipped anonymous classes entirely, so a private access
        // inside one (`o.#m` in `static fieldAccess(o) { return o.#m; }`)
        // resolved to NO declaring class → the brand check in property-access
        // was skipped → a wrong-brand receiver (`C.B.fieldAccess(C)`) read the
        // field instead of throwing TypeError (#3045). Same-named `#m` on a
        // nested class now each resolve to their own synthetic struct.
        // A NAMED class expression has two source spellings: its lexical
        // self-name (`class _Node`) and the outer binding (`var Node = ...`).
        // The registered Wasm class identity is still the per-declaration
        // synthetic name. Prefer that exact identity for every class
        // expression, named or anonymous; falling back to `_Node` makes a
        // widened receiver such as `let cur = this; cur = cur.#children[key]`
        // miss the private-field arm and incorrectly reach the host property
        // bridge, where private slots are intentionally invisible. Hono's
        // recursive TrieRouter then observes `cur.#methods` as null.
        const className = ts.isClassExpression(current)
          ? (ctx.anonClassExprNames.get(current) ?? current.name?.text)
          : current.name?.text;
        // Guard: the field must exist in the resolved struct (own private
        // *fields* live in structFields; a private method/getter is handled by
        // the accessor path in property-access, so require the field slot here).
        if (className !== undefined && ctx.structFields.get(className)?.some((f) => f.name === fieldName)) {
          const structTypeIdx = ctx.structMap.get(className);
          if (structTypeIdx !== undefined) {
            return { className, structTypeIdx, fieldName };
          }
        }
      }
    }
    current = current.parent;
  }
  return undefined;
}

/**
 * Resolve the physical struct that carries a private field on `this`.
 *
 * A variable-bound class expression is collected under both its visible
 * binding and a declaration-identity synthetic name. Both registrations point
 * at the same class-expression node, but a method compiled for the visible
 * binding receives that binding's struct while the private-name resolver
 * correctly returns the synthetic lexical identity. Coercing the former to
 * the latter before a `struct.set` materializes a field-by-field projection --
 * a fresh object -- so the write never reaches the original `this`.
 *
 * Preserve the method's actual self carrier only when both registrations are
 * proven to describe the exact same class declaration and the physical struct
 * owns the private slot. Declaration identity keeps same-named private fields
 * in unrelated classes distinct.
 */
export function resolvePrivateThisFieldCarrier(
  ctx: CodegenContext,
  fctx: FunctionContext,
  name: ts.PrivateIdentifier,
  receiver: ts.Expression,
): string | undefined {
  let bare = receiver;
  while (
    ts.isParenthesizedExpression(bare) ||
    ts.isAsExpression(bare) ||
    ts.isTypeAssertionExpression(bare) ||
    ts.isSatisfiesExpression(bare) ||
    ts.isNonNullExpression(bare)
  ) {
    bare = bare.expression;
  }
  if (bare.kind !== ts.SyntaxKind.ThisKeyword) return undefined;

  const declared = resolveDeclaringClassForPrivateName(ctx, name);
  if (declared === undefined) return undefined;
  const selfLocal = fctx.localMap.get("this");
  const selfType = selfLocal === undefined ? undefined : getLocalType(fctx, selfLocal);
  if (selfType?.kind !== "ref" && selfType?.kind !== "ref_null") return undefined;

  const physicalClassName = ctx.typeIdxToStructName.get(selfType.typeIdx);
  if (physicalClassName === undefined || physicalClassName === declared.className) return undefined;
  const lexicalDeclaration = ctx.classDeclarationMap.get(declared.className);
  if (
    lexicalDeclaration === undefined ||
    ctx.classDeclarationMap.get(physicalClassName) !== lexicalDeclaration ||
    !ctx.structFields.get(physicalClassName)?.some((field) => field.name === declared.fieldName)
  ) {
    return undefined;
  }
  return physicalClassName;
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
  fctx.body.push({ op: "ref.test", typeIdx: structTypeIdx });

  if (tagFieldIdx < 0 || allowedTags.length === 0) {
    return;
  }

  const tagChecks: Instr[] = [];
  for (let i = 0; i < allowedTags.length; i++) {
    tagChecks.push({ op: "local.get", index: receiverLocal });
    tagChecks.push({ op: "ref.cast", typeIdx: structTypeIdx });
    tagChecks.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx: tagFieldIdx });
    tagChecks.push({ op: "i32.const", value: allowedTags[i]! });
    tagChecks.push({ op: "i32.eq" });
    if (i > 0) {
      tagChecks.push({ op: "i32.or" });
    }
  }

  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "i32" } },
    then: tagChecks,
    else: [{ op: "i32.const", value: 0 }],
  });
}

/**
 * (#2709) True when `node` syntactically contains a `super(...)` call that would
 * be evaluated in the SAME `this`/`super` binding scope — i.e. without descending
 * into a nested function / method / class that introduces its own binding. Mirrors
 * the descent rules of `constructorBodyHasSuperCall` (class-bodies.ts). Used to
 * recognise the `super[super()]` SuperProperty-key shape.
 */
function expressionContainsSuperCall(node: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.SuperKeyword) {
      found = true;
      return;
    }
    // Do not descend into constructs that introduce a fresh `this`/`super`.
    // Arrow functions inherit the enclosing `this`, so they ARE descended into.
    if (
      ts.isFunctionDeclaration(n) ||
      ts.isFunctionExpression(n) ||
      ts.isMethodDeclaration(n) ||
      ts.isConstructorDeclaration(n) ||
      ts.isGetAccessorDeclaration(n) ||
      ts.isSetAccessorDeclaration(n) ||
      ts.isClassDeclaration(n) ||
      ts.isClassExpression(n)
    ) {
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

/**
 * (#2709) Uninitialized-`this` guard for a `super[key]` SuperProperty WRITE /
 * UPDATE (`super[key] = v`, `super[key]++`) in a *derived* constructor whose
 * `key` itself contains a `super(...)` call — i.e. the `super[super()] = 0` /
 * `super[super()]++` shape.
 *
 * Per ECMA-262 §13.3.7.1 (Evaluation of SuperProperty), reference resolution
 * performs `GetThisBinding()` FIRST (step 2), BEFORE the key Expression (step 3)
 * and the RHS. In a derived class `this` is *uninitialized* until `super(...)`
 * returns, so `GetThisBinding()` throws a `ReferenceError`. For the
 * `super[super()]` shape this is provably the outcome in EVERY execution:
 *   - if `super()` has not yet run, `this` is uninitialized → GetThisBinding
 *     throws ReferenceError before the key is evaluated;
 *   - if `super()` HAS already run, the key's inner `super()` is a second
 *     SuperCall → "Super constructor may only be called once" ReferenceError.
 * Either way the statement throws a ReferenceError and never completes, so
 * emitting an unconditional ReferenceError here is spec-correct. The shape
 * `super[super()] = …` never appears in valid programs, so this is ZERO
 * regression risk (no currently-passing path reaches it).
 *
 * Call at the TOP of the super-element write / update path, before any key/RHS
 * is emitted. Returns `true` when it emitted the throw (the caller should stop —
 * the inner `super()` and RHS must NOT be evaluated). Returns `false` (a no-op)
 * for every other shape, leaving existing behavior byte-identical.
 */
export function emitSuperUninitializedThisGuard(
  ctx: CodegenContext,
  fctx: FunctionContext,
  keyExpr: ts.Expression | undefined,
): boolean {
  if (!fctx.isDerivedConstructor) return false;
  if (!keyExpr || !expressionContainsSuperCall(keyExpr)) return false;
  emitThrowReferenceError(
    ctx,
    fctx,
    "Must call super constructor in derived class before accessing 'this' or returning from derived constructor",
  );
  return true;
}

/**
 * ECMA-262 Annex B.3.9 / AssignmentTargetType `web-compat` lowering.
 *
 * In non-strict code, a CallExpression may be parsed as an assignment/update/
 * for-in/of target. Its call is evaluated for side effects, then evaluation
 * throws ReferenceError before GetValue/ToNumeric, the RHS, or PutValue. The
 * early-error pass keeps strict-mode and logical-assignment forms out of
 * codegen, so reaching this helper for a call target identifies the normative
 * optional runtime path.
 */
export function emitWebCompatCallAssignmentTarget(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.Expression,
): boolean {
  let unwrapped = target;
  while (ts.isParenthesizedExpression(unwrapped)) unwrapped = unwrapped.expression;
  if (!ts.isCallExpression(unwrapped)) return false;

  const resultType = compileExpression(ctx, fctx, unwrapped);
  if (resultType !== null) fctx.body.push({ op: "drop" });
  emitThrowReferenceError(ctx, fctx, "Invalid left-hand side in assignment");
  return true;
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
  classNameHint?: string,
): { className: string; fieldName: string; kind: PrivateMemberKind } | undefined {
  const fieldName = "__priv_" + name.text.slice(1);

  // A folded direct-eval body is parsed into a synthetic SourceFile, so its
  // PrivateIdentifier has no parent chain leading back to the class that owns
  // the private name. The caller still carries that lexical class context on
  // the FunctionContext; use it as a narrow first probe before walking the
  // foreign AST below.
  const classifyInClass = (
    className: string,
  ): { className: string; fieldName: string; kind: PrivateMemberKind } | undefined => {
    const fullName = `${className}_${fieldName}`;
    if (ctx.classMethodSet.has(fullName) || ctx.staticMethodSet.has(fullName)) {
      return { className, fieldName, kind: "method" };
    }
    if (ctx.classAccessorSet.has(fullName)) {
      const hasGetter = ctx.funcMap.has(`${className}_get_${fieldName}`);
      const hasSetter = ctx.funcMap.has(`${className}_set_${fieldName}`);
      if (hasGetter && !hasSetter) return { className, fieldName, kind: "accessor-readonly" };
      if (hasSetter && !hasGetter) return { className, fieldName, kind: "accessor-writeonly" };
      return { className, fieldName, kind: "accessor" };
    }
    const structFields = ctx.structFields.get(className);
    if (structFields?.some((f) => f.name === fieldName)) {
      return { className, fieldName, kind: "field" };
    }
    return undefined;
  };

  if (classNameHint !== undefined) {
    const hinted = classifyInClass(classNameHint);
    if (hinted !== undefined) return hinted;
  }

  // Walk up parent links to find the lexically enclosing class that declares `#name`.
  // Unlike resolveDeclaringClassForPrivateName, we need to consider classes whose
  // PrivateIdentifier was registered as a method or accessor — those entries do
  // NOT appear in ctx.structFields, so the field-only lookup fails. We probe each
  // of method / accessor / field sets in turn.
  let current: ts.Node | undefined = name.parent;
  while (current) {
    if (ts.isClassDeclaration(current) || ts.isClassExpression(current)) {
      const className = ts.isClassExpression(current)
        ? (ctx.anonClassExprNames.get(current) ?? current.name?.text)
        : current.name?.text;
      if (!className) {
        current = current.parent;
        continue;
      }
      const classified = classifyInClass(className);
      if (classified !== undefined) return classified;
    }
    current = current.parent;
  }
  return undefined;
}

export function canonicalClassExpressionName(ctx: CodegenContext, className: string | undefined): string | undefined {
  return className === undefined ? undefined : (ctx.classExprNameMap.get(className) ?? className);
}

/**
 * Resolve the class body whose method ABI can consume this call's receiver.
 *
 * Variable-bound class expressions have a source-binding carrier and a
 * declaration-identity carrier. Public structural calls use the latter. A
 * private call normally uses its lexical declarer, except while compiling the
 * duplicate source body: there the captured `this` must call the equivalent
 * method whose self parameter has the exact same struct type. Descendants are
 * deliberately excluded because private names are never virtual overrides.
 */
export function resolveReceiverMethodClassName(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  receiverType: ts.Type,
): string | undefined {
  const symbolClassName = receiverType.getSymbol()?.name;
  if (!ts.isPrivateIdentifier(propAccess.name)) {
    // TypeScript reuses the class-expression display name for unrelated
    // declarations (Marked has both `class l` Lexer and `class l` Parser).
    // Prefer declaration identity over that display name so an imported class
    // alias cannot resolve to whichever same-named class was collected last.
    return exactClassExpressionTypeName(ctx, receiverType) ?? canonicalClassExpressionName(ctx, symbolClassName);
  }

  const privateMember = classifyPrivateMember(ctx, propAccess.name);
  if (privateMember?.kind !== "method") {
    return canonicalClassExpressionName(ctx, symbolClassName);
  }
  const lexicalClassName = privateMember.className;
  if (propAccess.expression.kind !== ts.SyntaxKind.ThisKeyword) return lexicalClassName;

  const thisLocalIdx = fctx.localMap.get("this");
  const thisType = thisLocalIdx === undefined ? undefined : getLocalType(fctx, thisLocalIdx);
  if (thisType?.kind !== "ref" && thisType?.kind !== "ref_null") return lexicalClassName;

  const privateMethodName = `__priv_${propAccess.name.text.slice(1)}`;
  const owners: string[] = [];
  for (const [className, typeIdx] of ctx.structMap) {
    if (className !== lexicalClassName && ctx.classExprNameMap.get(className) !== lexicalClassName) continue;
    if (typeIdx !== thisType.typeIdx) continue;
    const fullName = `${className}_${privateMethodName}`;
    const methodHandle = ctx.funcMap.get(classMemberFuncKey(ctx, fullName)) ?? ctx.funcMap.get(fullName);
    const methodSelfType = methodHandle === undefined ? undefined : getFuncParamTypes(ctx, methodHandle)?.[0];
    if (
      (methodSelfType?.kind === "ref" || methodSelfType?.kind === "ref_null") &&
      methodSelfType.typeIdx === thisType.typeIdx
    ) {
      owners.push(className);
    }
  }
  if (owners.length > 1) {
    throw new Error(
      `private receiver owner is ambiguous for ${propAccess.name.text} in ${fctx.name}: ${owners.join(", ")}`,
    );
  }
  return owners[0] ?? lexicalClassName;
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
  // #1916 S2 — funcSignatureOf is the positional-read chokepoint (func-space.ts).
  return funcSignatureOf(ctx, funcIdx)?.params;
}

/**
 * Check if a Wasm function (by index) has a void return type by inspecting
 * the actual function type in the module. This is the ground truth for whether
 * a `call` instruction pushes a value onto the stack.
 */
export function wasmFuncReturnsVoid(ctx: CodegenContext, funcIdx: number): boolean {
  // #1916 S2 — funcSignatureOf is the positional-read chokepoint (func-space.ts).
  const sig = funcSignatureOf(ctx, funcIdx);
  return !sig || sig.results.length === 0; // not found — assume void to be safe
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
  // #1916 S2 — funcSignatureOf is the positional-read chokepoint (func-space.ts).
  const sig = funcSignatureOf(ctx, funcIdx);
  return sig && sig.results.length > 0 ? sig.results[0]! : undefined;
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

/**
 * (#3429) Resolve the static declared name of an argument expression that is
 * a bare Identifier bound to a USER-COMPILED, top-level named
 * FunctionDeclaration — i.e. a genuine js2wasm closure value, never an
 * ambient `declare`d builtin (those cross the host boundary as real native
 * functions already, unaffected by the bug this fixes). Returns `undefined`
 * for anything else (computed values, aliases through a variable, anonymous
 * functions, ambient declarations, class values, …) — the caller leaves such
 * arguments untouched.
 *
 * Deliberately does NOT consult the raw TypeScript checker at all (no
 * `getSymbolAtLocation`/`getTypeAtLocation` reach-in) — the membership test
 * is `ctx.topLevelFunctionNames` (`src/codegen/index.ts` /
 * `declarations.ts`), the SAME hoisting-time registry `class-member-keys.ts`
 * and `call-builtin-static.ts` already use to answer "is this identifier a
 * real compiled top-level function". It is populated purely from AST
 * declaration collection (never from an ambient `.d.ts`), so membership
 * alone proves the value is a genuine js2wasm-compiled closure — no
 * `ts.Type`/symbol query needed. (Routing through `ctx.oracle` instead was
 * considered: `typeFactOf` classifies both `TypeError` — ambient, callable —
 * and a user `function MyError(){}` as the SAME `{ kind: "function" }` fact,
 * so it cannot make the ambient/compiled distinction this stamp depends on
 * for safety — stamping a REAL native builtin's `.name` via `__extern_set`
 * would touch it unnecessarily. `topLevelFunctionNames` makes the distinction
 * for free.)
 *
 * KNOWN LIMITATIONS (documented on purpose, not targets for this fix):
 * - Pure static, per-call-site fold — only fires when the argument
 *   expression is DIRECTLY the identifier bound to the declaration. An
 *   indirection (`const E = MyError; assert.throws(E, fn)`) or a computed
 *   value (`assert.throws(getCtor(), fn)`) is left unstamped.
 * - FunctionDeclaration only (not function expressions / classes) — narrower
 *   than the original checker-based version, but matches every confirmed
 *   #3429 sample (`function Test262Error(){}`, `function MyError(){}`,
 *   `function DummyError(){}` — test262's pervasive marker-error idiom).
 */
function resolveCompiledFunctionArgName(ctx: CodegenContext, argExpr: ts.Expression): string | undefined {
  if (!ts.isIdentifier(argExpr)) return undefined;
  const name = argExpr.text;
  return name && ctx.topLevelFunctionNames.has(name) ? name : undefined;
}

/**
 * (#3429) Stamp the real declared `.name` onto a compiled-closure/class
 * argument BEFORE it crosses the host boundary, when {@link
 * resolveCompiledFunctionArgName} can resolve it statically. Without this, a
 * user-defined constructor value (e.g. `Test262Error`, or a per-test
 * `function MyError(){}`) crossing into a host-delegated call
 * (`__extern_method_call` / a static-method dispatch / a super method call)
 * gets wrapped by the runtime's generic unknown-arity closure bridge
 * (`_wrapWasmClosureUnknownArity`, runtime.ts), which presents `.name ===
 * "wasmClosureDynamicBridge"` (the bridge's own literal function name)
 * instead of the wrapped closure's real name. The stamp writes into the
 * value's `_wasmStructProps` sidecar via `__extern_set(val, "name", ...)`,
 * which `_wrapWasmClosureUnknownArity` already consults (mirrors the
 * existing `.name`/`.length` sidecar stamp in `_wrapCallableForHost`).
 *
 * Call this AFTER the argument has been compiled and coerced onto the stack
 * as an externref (the top-of-stack value). If a name is resolved, the value
 * is moved into a fresh local, stamped, and reloaded — net stack effect is
 * unchanged (`[... val] -> [... val]`), so callers that don't check the
 * return value keep working: the emitted bytes for a non-matching argument
 * are byte-identical to the pre-#3429 path (this function is a no-op).
 *
 * Returns `true` when a stamp was emitted (informational only — the caller
 * doesn't need to branch on it since the stack effect is always `[val]`).
 */
export function maybeStampCompiledFunctionArgName(
  ctx: CodegenContext,
  fctx: FunctionContext,
  argExpr: ts.Expression,
): boolean {
  // (#3429) JS-host only. `wasmClosureDynamicBridge` — the bug this fixes —
  // is a JS-host runtime.ts construct; standalone/WASI have no JS host to
  // bridge into, so the bug this fixes cannot occur there. Gate strictly to
  // avoid any behavioral change to standalone/WASI codegen (out of scope).
  if (ctx.standalone || ctx.wasi) return false;
  const constName = resolveCompiledFunctionArgName(ctx, argExpr);
  if (constName === undefined) return false;
  const setIdx = ensureLateImport(
    ctx,
    "__extern_set",
    [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
    [],
  );
  flushLateImportShifts(ctx, fctx);
  if (setIdx === undefined) return false;
  addStringConstantGlobal(ctx, "name");
  addStringConstantGlobal(ctx, constName);

  const argLocal = allocLocal(fctx, `__argname_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: argLocal });
  fctx.body.push({ op: "local.get", index: argLocal });
  fctx.body.push(...stringConstantExternrefInstrs(ctx, "name"));
  fctx.body.push(...stringConstantExternrefInstrs(ctx, constName));
  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__extern_set") ?? setIdx });
  fctx.body.push({ op: "local.get", index: argLocal });
  return true;
}
