// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Class declaration collection and class body compilation.
 *
 * Extracted from codegen/index.ts (#1013).
 */
import { ts } from "../ts-api.js";
import { findConstructorImplementation, hasStaticModifier } from "./ast-modifiers.js";
import { nativeTypeFromTypeNode, nativeTypeOfDeclaration } from "./native-type-annotations.js";
import { resolveIrDynamicCarrierType } from "./any-helpers.js";
import { isVoidType, unwrapPromiseType } from "../checker/type-mapper.js";
import type { FieldDef, Instr, StructTypeDef, ValType } from "../ir/types.js";
import type { IrUnitId } from "../ir/identity.js";
import { isBoundedPreparedNestedOrdinaryClass } from "../ir/class-accessor-safety.js"; // (#3522) nested implicit-ctor family
import { isHostConstructibleBuiltin, isNativeCollectionBuiltin } from "./builtin-tags.js";
import { isStandalonePromiseActive } from "./async-scheduler.js"; // (#2637 B2) host-only Promise-subclass ctor gate
// (#3132 S2a) Bounded async-generator METHOD drive: no-`this`/`super`/
// `arguments` methods route through the same native producer as fn
// declarations/expressions (the drive gate self-limits to standalone/wasi).
import { emitAsyncGenerator, isAsyncGenDriveCandidate } from "./async-frame.js";
import { genBodyReferencesThis, genBodyReferencesSuper, emitCachedFuncClosureAccess } from "./closures.js"; // (#3132 / #3123 fnctor parent closure)
import { classMemberFuncKey, fnctorAncestorOfClass } from "./class-member-keys.js"; // (#1983 / #3123)
import { recordFnMetaMemberDeclaration } from "./function-instance-meta-methods.js"; // (#4440)
import { exactClassExpressionTypeName } from "./class-expression-identity.js";
import { installAstFreeClassConstructorNewWrapper } from "./class-constructor-wrapper.js";
import { commitClassStructLayout } from "./class-layout-registration.js";
import { mintDefinedFunc, pushProgramAbiClassCallable } from "./program-abi-class-callable-planning.js";
import { setProgramAbiInheritedClassCallableAlias } from "./program-abi-class-callable-planning.js";
import { absoluteFuncIndex } from "../emit/resolve-layout.js"; // (#1916 S3b) resolve handles for order-stable declaredFuncRefs sort
import { definedFuncAt } from "./func-space.js";
import { getOrAssignClassNewTargetId } from "./new-target.js"; // (#2023)
import { popBody, pushBody } from "./context/bodies.js";
import { reportError } from "./context/errors.js";
import { allocLocal, deduplicateLocals } from "./context/locals.js";
import type { CodegenContext, FunctionContext, OptionalParamInfo } from "./context/types.js";
import {
  buildDestructureNullThrow,
  destructureParamArray,
  destructureParamObject,
  isNullOrUndefinedLiteral,
  structHintForBindingPattern,
} from "./destructuring-params.js";
import { emitThrowReferenceError, emitThrowTypeError, getFuncParamTypes } from "./expressions/helpers.js";
import { pushDefaultValue } from "./type-coercion.js";
import { bodyNeedsArgumentsObject, needsImplicitArgumentsObject } from "./helpers/body-uses-arguments.js";
import {
  compileNativeGeneratorFunction,
  isNativeGeneratorCandidate,
  registerNativeGenerator,
} from "./generators-native.js"; // (#2571) native method-generator lowering
import {
  cacheStringLiterals,
  extractConstantDefault,
  hoistLetConstWithTdz, // (#2641) lexical shadowing in class method/ctor/generator bodies
  hoistVarDeclarations, // (#2641)
  resolveWasmType,
} from "./index.js";
import { detectStringBuilders } from "./string-builder.js"; // (#2641/#1210) string-builder fast-path parity in class methods
import type { StringBuilderPresizeInfo } from "./string-builder.js";
import { emitUndefined } from "./expressions/late-imports.js";
import { addStringConstantGlobal, ensureExnTag, nextModuleGlobalIdx } from "./registry/imports.js";
import { buildTargetTaggedTry } from "../ir/try-table.js";
import { emitWasiErrorConstructor, getOrRegisterErrorStructType, isWasiErrorName } from "./registry/error-types.js";
import {
  emitStandaloneArrayConstructor, // (#2917) native `class Sub extends Array`
  emitStandaloneVecBuiltinConstructor, // (#3239) native `class Sub extends <TypedArray|SharedArrayBuffer>`
  STANDALONE_VEC_BUILTIN_PARENTS,
} from "./object-runtime.js";
import {
  emitStandaloneObjectConstructor, // (#3238) native `class Sub extends Object`
  resolveStandaloneSubclassBuiltinCtor, // (#3972) the identity/collection/wrapper arms
} from "./standalone-subclass-ctors.js";
import { addFuncType, getArrTypeIdxFromVec, getOrRegisterVecType } from "./registry/types.js";
import {
  cacheParamDefaultArgc,
  emitF64ParamSentinelCheck,
  emitParamDefaultArgMissingCheck,
  ensureCurrentThisGlobal, // (#2637 B2.3) read host `this` (__current_this) in the run-on-host ctor
  maybeSetArgcForKnownCall,
  paramDefaultNeedsArgc,
} from "./statements/nested-declarations.js";
import {
  coerceType,
  compileExpression,
  compileStatement,
  emitArgumentsObject,
  emitBoundsCheckedArrayGet,
  ensureLateImport,
  flushLateImportShifts,
  resolveComputedKeyExpression,
  valTypesMatch,
} from "./shared.js";

/**
 * (#846h / #1682) Returns true if `body` lexically contains a `super(...)` call
 * that shares the constructor's `this` binding. Descends through ordinary
 * statements and arrow-function bodies (which inherit `this`), but NOT into
 * nested function/method/class declarations or function expressions, where a
 * `super()` would bind a different constructor. Used to detect a derived
 * constructor that never initialises `this` — per ES §10.2.2 / §13.3.7.1 such a
 * constructor must throw a ReferenceError when constructed.
 */
function constructorBodyHasSuperCall(node: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    // A `super(...)` CallExpression initialises `this`.
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.SuperKeyword) {
      found = true;
      return;
    }
    // Do not descend into constructs that introduce a new `this`/`super` binding.
    // Note: arrow functions ARE descended into — they inherit the enclosing
    // constructor's `this`, so a `super()` inside an arrow still initialises it.
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
  ts.forEachChild(node, visit);
  return found;
}

function getBuiltinConstructorForwardArity(ctx: CodegenContext, builtinParent: string): number {
  const declaredArity = ctx.externClasses.get(builtinParent)?.constructorParams.length ?? 0;
  return Math.max(1, declaredArity);
}

/**
 * Resolve the host constructor import for an extern-class parent.
 *
 * Builtin parents historically use the synthetic `__new_<Name>` imports,
 * while classes declared by a host module use the extern registry's prefix
 * (for example `events_EventEmitter_new`).  Keeping this distinction in one
 * helper is important for derived classes: their `super()` call is otherwise
 * silently routed to a non-existent `__new_EventEmitter` import.
 */
function getParentConstructorImportName(ctx: CodegenContext, parentName: string): string {
  const info = ctx.externClasses.get(parentName);
  return info ? `${info.importPrefix}_new` : `__new_${parentName}`;
}

/**
 * Return the host-visible constructor lookup key used by `__set_subclass_proto`.
 * Node module classes are not globals, so pass a dotted namespace path (for
 * example `events.EventEmitter`) for the runtime to resolve through require().
 */
function getParentPrototypeLookupName(ctx: CodegenContext, parentName: string): string {
  const info = ctx.externClasses.get(parentName);
  if (!info) return parentName;
  return [...info.namespacePath, info.className].join(".") || info.className;
}

/**
 * (#2637 B2) True when `className` is a `class … extends Promise` (transitively)
 * with a user-declared constructor, in JS-host mode. These are the only classes
 * for which the run-on-host-`this` constructor body (`${className}_new__onhost`)
 * + the `__register_promise_subclass_ctor` registration are emitted: V8's
 * `NewPromiseCapability(C)` performs `new C(internalExecutor)`, and the runtime
 * (`__promise_subclass_ctor`, runtime.ts) runs the registered closure on the
 * capability promise.
 *
 * `classBuiltinParentMap` already records the transitive builtin ancestor
 * (collection propagates it for multi-level chains, see collectClassDeclaration
 * lines ~588-608), so a direct `=== "Promise"` check covers `class A extends
 * Promise` and `class B extends A` alike. Standalone/WASI has no JS host, so
 * `__promise_subclass_ctor` / the registration import are unsatisfiable there —
 * return false (standalone keeps the #1941 fallback; the synthesized-subclass
 * path is JS-host-only).
 *
 * Default-constructor subclasses (no `ctor`) are excluded: they have no user
 * body to run, so the runtime's bare forwarder (the #1977 identity-only path)
 * is correct and no registration is needed.
 */
function isPromiseSubclassWithUserCtor(
  ctx: CodegenContext,
  className: string,
  ctor: ts.ConstructorDeclaration | undefined,
): boolean {
  if (ctor === undefined) return false;
  // Gate EXACTLY as `resolvePromiseSubclassName` (the combinator/value-read
  // emitter) does, so the `__onhost` body + registration are emitted iff the
  // combinator path will reference them.
  if (isStandalonePromiseActive(ctx)) return false;
  return ctx.classBuiltinParentMap.get(className) === "Promise";
}

function countStaticallyKnownArgs(
  args: ts.NodeArray<ts.Expression> | readonly ts.Expression[] | undefined,
): number | undefined {
  if (!args) return 0;
  let count = 0;
  for (const arg of args) {
    if (ts.isSpreadElement(arg)) {
      if (!ts.isArrayLiteralExpression(arg.expression)) return undefined;
      count += arg.expression.elements.length;
    } else {
      count++;
    }
  }
  return count;
}

function flattenStaticallyKnownArgs(
  args: ts.NodeArray<ts.Expression> | readonly ts.Expression[],
): ts.Expression[] | null {
  const result: ts.Expression[] = [];
  for (const arg of args) {
    if (ts.isSpreadElement(arg)) {
      if (!ts.isArrayLiteralExpression(arg.expression)) return null;
      for (const element of arg.expression.elements) {
        result.push(element);
      }
    } else {
      result.push(arg);
    }
  }
  return result;
}

function emitClassParamDefaultCheck(
  ctx: CodegenContext,
  fctx: FunctionContext,
  paramIdx: number,
  paramType: ValType,
  thenInstrs: Instr[],
  argIndex: number,
  argcLocal: number | undefined,
): void {
  if (paramType.kind === "externref") {
    fctx.body.push({ op: "local.get", index: paramIdx });
    const isUndefIdx = ensureLateImport(ctx, "__extern_is_undefined", [{ kind: "externref" }], [{ kind: "i32" }]);
    if (isUndefIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx: isUndefIdx });
    } else {
      fctx.body.push({ op: "ref.is_null" });
    }
  } else if (paramType.kind === "ref_null" || paramType.kind === "ref") {
    fctx.body.push({ op: "local.get", index: paramIdx });
    fctx.body.push({ op: "ref.is_null" });
  } else if (paramType.kind === "i32") {
    emitParamDefaultArgMissingCheck(fctx, argcLocal!, argIndex);
  } else if (paramType.kind === "f64") {
    emitParamDefaultArgMissingCheck(fctx, argcLocal!, argIndex);
    emitF64ParamSentinelCheck(fctx, paramIdx);
    fctx.body.push({ op: "i32.or" });
  } else {
    return;
  }
  fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: thenInstrs });
}

function registerClassOptionalParams(
  ctx: CodegenContext,
  funcName: string,
  parameters: ts.NodeArray<ts.ParameterDeclaration>,
  paramTypes: ValType[],
  paramTypeOffset = 0,
): void {
  const optionalParams: OptionalParamInfo[] = [];
  for (let i = 0; i < parameters.length; i++) {
    const param = parameters[i]!;
    if (!param.questionToken && !param.initializer) continue;
    const type = paramTypes[paramTypeOffset + i];
    if (!type) continue;
    const info: OptionalParamInfo = { index: i, type };
    if (param.initializer) {
      const cd = extractConstantDefault(param.initializer, type, ctx);
      if (cd) info.constantDefault = cd;
      else info.hasExpressionDefault = true;
    }
    optionalParams.push(info);
  }
  if (optionalParams.length > 0) {
    ctx.funcOptionalParams.set(funcName, optionalParams);
  }
}

function unwrapParenthesized(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (ts.isParenthesizedExpression(current)) {
    current = current.expression;
  }
  return current;
}

function newExpressionTargetsClass(
  ctx: CodegenContext,
  expr: ts.NewExpression,
  decl: ts.ClassDeclaration | ts.ClassExpression,
  className: string,
): boolean {
  const callee = unwrapParenthesized(expr.expression);
  if (callee === decl) return true;
  if (!ts.isIdentifier(callee)) return false;

  const targetSymbol = ctx.checker.getSymbolAtLocation(callee);
  const targetDecls = targetSymbol?.getDeclarations() ?? [];
  if (targetDecls.some((d) => d === decl || (ts.isVariableDeclaration(d) && d.initializer === decl))) {
    return true;
  }
  if (targetSymbol !== undefined) return false;

  return (ctx.classExprNameMap.get(callee.text) ?? callee.text) === className;
}

function getObservedClassNewArity(
  ctx: CodegenContext,
  decl: ts.ClassDeclaration | ts.ClassExpression,
  className: string,
): number {
  let maxArity = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node) && newExpressionTargetsClass(ctx, node, decl, className)) {
      const argCount = countStaticallyKnownArgs(node.arguments);
      if (argCount !== undefined) maxArity = Math.max(maxArity, argCount);
    }
    ts.forEachChild(node, visit);
  };
  visit(decl.getSourceFile());
  return maxArity;
}

function getImplicitExternrefForwarderArity(
  ctx: CodegenContext,
  decl: ts.ClassDeclaration | ts.ClassExpression,
  className: string,
  builtinParent: string,
): number {
  return Math.max(
    getBuiltinConstructorForwardArity(ctx, builtinParent),
    getObservedClassNewArity(ctx, decl, className),
  );
}

function externrefParams(count: number): ValType[] {
  return Array.from({ length: count }, () => ({ kind: "externref" }) as ValType);
}

/**
 * (#2917 shared resolver) Standalone/WASI dispatch ladder for native
 * `__new_<Parent>` super-construction — the single source of truth for which
 * builtin parents construct host-free, shared by the implicit-derived-ctor
 * forwarder and `compileSuperCall`'s explicit-`super(...)` arm (previously
 * copy-paste twins; per-builtin slices of #2917 extend THIS ladder only).
 *
 * Arms: Error family (#1536c, real `$Error_struct`) → `Object` (#3238) →
 * `Array` (#2917, real `$__vec_externref` honoring Array(...) argument
 * semantics) → TypedArray/SharedArrayBuffer (#3239, identity-only empty vec) →
 * the #3972 groups (identity carrier / real `$Map` / real wrapper box; see
 * standalone-subclass-ctors.ts). All helpers register PER-ARITY and return the
 * DEFINED funcIdx (no import → no index shift).
 *
 * Returns:
 *   - `number` — a native arm matched; call this DEFINED funcIdx.
 *   - `null` — a native arm matched but its helper could not register
 *     (defensive). The caller must NOT fall back to the host import (it
 *     would leak `env::__new_<Parent>`); the legacy first-arg-as-instance
 *     fallback applies instead.
 *   - `undefined` — no native arm (gc/host mode, or a parent with no native
 *     ctor yet): caller falls back to `ensureLateImport` exactly as before.
 */
function resolveStandaloneBuiltinSuperCtorIdx(
  ctx: CodegenContext,
  parentName: string,
  arity: number,
): number | null | undefined {
  const hostFree = ctx.wasi || ctx.standalone;
  if (!hostFree && ctx.targetProfile.semanticProviders !== "native-first") return undefined;
  if (isWasiErrorName(parentName)) {
    emitWasiErrorConstructor(ctx, parentName, arity);
    return ctx.funcMap.get(`__new_${parentName}`) ?? null;
  }
  if (!hostFree) return undefined;
  if (parentName === "Object") {
    return emitStandaloneObjectConstructor(ctx, arity) ?? null;
  }
  if (parentName === "Array") {
    return emitStandaloneArrayConstructor(ctx, arity) ?? null;
  }
  if (STANDALONE_VEC_BUILTIN_PARENTS.has(parentName)) {
    return emitStandaloneVecBuiltinConstructor(ctx, `__new_${parentName}`, arity) ?? null;
  }
  // (#3972) ArrayBuffer/DataView/Date/Function/Promise/RegExp/WeakRef (identity
  // carrier), Map/Set/WeakMap/WeakSet (real brand-stamped `$Map`), and
  // Number/Boolean (real `$Object` wrapper box) — see
  // standalone-subclass-ctors.ts for the per-group carrier rationale and scope.
  return resolveStandaloneSubclassBuiltinCtor(ctx, parentName, arity);
}

/**
 * #2082: for a derived class with NO explicit constructor and a WasmGC-struct
 * parent, the spec synthesizes `constructor(...args) { super(...args); }`
 * (§15.7.14). Walk the parent chain to the nearest ancestor that declares an
 * explicit constructor and return its parameter list, so the implicit ctor is
 * synthesized with the same parameters (bound as locals) and the replayed
 * parent `this.x = param` assignments can resolve `param`. Returns undefined
 * when no ancestor has an explicit constructor (no args to forward).
 */
function findNearestAncestorCtorParams(
  ctx: CodegenContext,
  className: string,
): ts.NodeArray<ts.ParameterDeclaration> | undefined {
  const seen = new Set<string>([className]);
  let anc = ctx.classParentMap.get(className);
  while (anc && !seen.has(anc)) {
    seen.add(anc);
    const ancDecl = ctx.classDeclarationMap.get(anc);
    const ancCtor = ancDecl ? findConstructorImplementation(ancDecl) : undefined;
    if (ancCtor) return ancCtor.parameters;
    anc = ctx.classParentMap.get(anc);
  }
  return undefined;
}

/**
 * #2086: single source of truth for the parameter prefix synthesized for an
 * implicit derived constructor (`constructor(...args){ super(...args) }`,
 * §15.7.14). The rule was previously realized twice — once for func-type
 * registration and once for the `FunctionContext` build — and the two copies
 * drifted (each point fix #1833/#2082/#2078 landed in one phase or one
 * representation lane). Both phases now derive the prefix from this function.
 *
 * `implicitForwarderArity` (the externref-backed built-in lane, #1833) and
 * `implicitStructCtorParams` (the WasmGC-struct lane, #2082) are mutually
 * exclusive by construction (`implicitStructCtorParams` is only computed for a
 * non-builtin parent), so the returned list has at most one of the two shapes.
 * `ctor` (the explicit-constructor case) is handled by the callers, not here —
 * this helper covers only the *implicit* (no own ctor) synthesis.
 */
function computeImplicitDerivedCtorPrefix(
  ctx: CodegenContext,
  decl: ts.ClassDeclaration | ts.ClassExpression,
  className: string,
  ctor: ts.ConstructorDeclaration | undefined,
): {
  implicitBuiltinParent: string | undefined;
  implicitForwarderArity: number;
  implicitStructCtorParams: ts.NodeArray<ts.ParameterDeclaration> | undefined;
  prefixParams: { name: string; type: ValType }[];
} {
  const implicitBuiltinParent = !ctor ? ctx.classBuiltinParentMap.get(className) : undefined;
  const implicitForwarderArity = implicitBuiltinParent
    ? getImplicitExternrefForwarderArity(ctx, decl, className, implicitBuiltinParent)
    : 0;
  const implicitStructCtorParams =
    !ctor && !implicitBuiltinParent ? findNearestAncestorCtorParams(ctx, className) : undefined;

  const prefixParams: { name: string; type: ValType }[] = [];
  for (let i = 0; i < implicitForwarderArity; i++) {
    prefixParams.push({ name: `__arg${i}`, type: { kind: "externref" } });
  }
  if (implicitStructCtorParams) {
    for (let pi = 0; pi < implicitStructCtorParams.length; pi++) {
      const param = implicitStructCtorParams[pi]!;
      const paramName = ts.isIdentifier(param.name) ? param.name.text : `__param${pi}`;
      const paramType = ctx.checker.getTypeAtLocation(param);
      let wasmType = resolveWasmType(ctx, paramType);
      // Widen ref→ref_null for params with defaults (caller passes ref.null as
      // the omitted-arg sentinel). Must match the explicit-ctor widening below.
      if (param.initializer && wasmType.kind === "ref") {
        wasmType = { kind: "ref_null", typeIdx: (wasmType as { kind: "ref"; typeIdx: number }).typeIdx };
      }
      prefixParams.push({ name: paramName, type: wasmType });
    }
  }
  return { implicitBuiltinParent, implicitForwarderArity, implicitStructCtorParams, prefixParams };
}

function compileExternrefArgument(ctx: CodegenContext, fctx: FunctionContext, arg: ts.Expression): void {
  const argResult = compileExpression(ctx, fctx, arg, { kind: "externref" });
  if (argResult === null) {
    emitUndefined(ctx, fctx);
    return;
  }
  if (argResult.kind !== "externref") {
    coerceType(ctx, fctx, argResult, { kind: "externref" });
  }
}

function evaluateArgumentForSideEffects(ctx: CodegenContext, fctx: FunctionContext, arg: ts.Expression): void {
  const inner = ts.isSpreadElement(arg) ? arg.expression : arg;
  const argResult = compileExpression(ctx, fctx, inner);
  if (argResult !== null) {
    fctx.body.push({ op: "drop" });
  }
}

/**
 * (#1455) Emit the call sequence that adjusts an externref-backed subclass
 * instance's [[Prototype]] from `Parent.prototype` (set by `__new_<Parent>(...)`)
 * to a synthetic `Sub.prototype` whose own [[Prototype]] is `Parent.prototype`.
 * This is the missing step from `Reflect.Construct(Parent, args, Sub)` — without
 * it, `instance instanceof Sub` returns false because the chain never reaches
 * `Sub.prototype`. With it, both `instance instanceof Sub` and
 * `instance instanceof Parent` (and grandparents) return true.
 *
 * Pre-condition: the instance externref is in `selfLocal`.
 * Post-condition: `selfLocal` holds the same instance with its prototype set.
 * Idempotent: a Wasm-side null check guards repeated calls; the host import
 * also early-returns when the prototype is already correct.
 *
 * Standalone (no host import): no-op — `selfLocal` is left unchanged.
 */
function emitSetSubclassProto(
  ctx: CodegenContext,
  fctx: FunctionContext,
  selfLocal: number,
  subName: string,
  parentName: string,
): void {
  const setProtoIdx = ensureLateImport(
    ctx,
    "__set_subclass_proto",
    [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
    [{ kind: "externref" }],
  );
  flushLateImportShifts(ctx, fctx);
  if (setProtoIdx === undefined) {
    // Standalone path: no host import available — leave instance alone.
    return;
  }
  const parentLookupName = getParentPrototypeLookupName(ctx, parentName);
  addStringConstantGlobal(ctx, subName);
  addStringConstantGlobal(ctx, parentLookupName);
  const subNameGlobal = ctx.stringGlobalMap.get(subName);
  const parentNameGlobal = ctx.stringGlobalMap.get(parentLookupName);
  // (#2029) In `--target standalone`/`nativeStrings`, `addStringConstantGlobal`
  // stores the documented `-1` sentinel ("no host `string_constants` global —
  // materialize the literal inline at use sites", see registry/imports.ts).
  // The class-name strings here exist only to feed the `__set_subclass_proto`
  // HOST import — which is itself unavailable standalone — so a `global.get -1`
  // would be baked and crash binary emit (`u32 out of range: -1`). Guarding only
  // `=== undefined` (a missing key) missed this in-pool `-1` value, the
  // builtin-subclass cluster of the #2029 emit bucket. Skip the proto adjustment
  // when either name resolves to the sentinel (or is absent): there is no host to
  // call, and the WasmGC instance tag already carries class identity for
  // `instanceof`.
  if (subNameGlobal === undefined || parentNameGlobal === undefined || subNameGlobal < 0 || parentNameGlobal < 0) {
    // String pool not available, or the standalone `-1` sentinel — skip silently.
    return;
  }
  // Skip when the instance is null (e.g. standalone `__new_<Parent>` fallback);
  // calling Object.setPrototypeOf on null/undefined throws in JS, which we
  // do not want here. Use ref.is_null + if/else (avoids leaving stack imbalanced).
  fctx.body.push({ op: "local.get", index: selfLocal });
  fctx.body.push({ op: "ref.is_null" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [],
    else: [
      { op: "local.get", index: selfLocal },
      { op: "global.get", index: subNameGlobal },
      { op: "global.get", index: parentNameGlobal },
      { op: "call", funcIdx: setProtoIdx },
      { op: "local.set", index: selfLocal },
    ],
  });
}

/**
 * (#2188) Brand a standalone-native user Error subclass instance with its own
 * `classTagMap` id, so sibling `extends Error` subclasses (which all share the
 * SAME builtin parent `$tag`) can be told apart by `instanceof`.
 *
 * `selfLocal` holds the instance externref produced by `__new_<Parent>` (a real
 * `$Error_struct`, see emitWasiErrorConstructor). We convert it back to anyref,
 * `ref.test` that it is genuinely an `$Error_struct` (defensive — the standalone
 * `__new_<Parent>` fallback can leave a non-struct value here), and when it is,
 * write the subclass's unique tag into `$Error_struct.$userClassId` (fieldIdx 4).
 * The standalone `instanceof <UserSubclass>` path (identifiers.ts) reads this
 * field. No host import — pure WasmGC, so it works in `--target wasi`.
 *
 * Only emitted in standalone / WASI mode: in JS-host mode the instance is a real
 * JS Error object (not an `$Error_struct`), `instanceof` routes through the host,
 * and the brand field does not exist on it. Guarded by the caller.
 */
function emitSetSubclassUserBrand(
  ctx: CodegenContext,
  fctx: FunctionContext,
  selfLocal: number,
  subName: string,
): void {
  if (!(ctx.wasi || ctx.standalone)) return;
  const brand = ctx.classTagMap.get(subName);
  if (brand === undefined) return;
  const structIdx = getOrRegisterErrorStructType(ctx);
  // anyref view of the instance, stash it so the `ref.test`-guarded write can
  // re-read it without recomputing.
  const anyLocalIdx = allocLocal(fctx, `__err_brand_${fctx.locals.length}`, { kind: "anyref" } as ValType);
  fctx.body.push({ op: "local.get", index: selfLocal });
  fctx.body.push({ op: "any.convert_extern" });
  fctx.body.push({ op: "local.set", index: anyLocalIdx });
  fctx.body.push({ op: "local.get", index: anyLocalIdx });
  fctx.body.push({ op: "ref.test", typeIdx: structIdx });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [
      { op: "local.get", index: anyLocalIdx },
      { op: "ref.cast", typeIdx: structIdx },
      { op: "i32.const", value: brand },
      { op: "struct.set", typeIdx: structIdx, fieldIdx: 4 },
    ],
    else: [],
  });
}

export function resolveClassMemberName(ctx: CodegenContext, name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isPrivateIdentifier(name)) return "__priv_" + name.text.slice(1);
  if (ts.isStringLiteral(name)) return name.text;
  if (ts.isNumericLiteral(name)) return String(Number(name.text));
  if (ts.isComputedPropertyName(name)) {
    return resolveComputedKeyExpression(ctx, name.expression);
  }
  return undefined;
}

// (#1983) `classMemberFuncKey` lives in the leaf module `class-member-keys.ts`
// (imported above) so consumer files can use it without an import cycle; it is
// re-exported here for callers that already import from `class-bodies.js`.
export { classMemberFuncKey } from "./class-member-keys.js";

/**
 * Resolve an accessor parameter once for both callable allocation and body
 * re-resolution. A promoted direct-child setter with no annotation is an
 * exact dynamic writeback boundary; the checker may otherwise infer its type
 * from the paired getter and silently change the physical callable ABI.
 */
function resolveClassAccessorParameterType(
  ctx: CodegenContext,
  member: ts.SetAccessorDeclaration,
  param: ts.ParameterDeclaration,
): ValType {
  const unitId = ctx.irPlanningIdentityContext?.unitIdByDeclaration.get(member);
  const terminal = unitId === undefined ? undefined : ctx.irPlanningIdentityContext?.terminalByUnitId.get(unitId);
  if (param.type === undefined) {
    if (terminal?.containingTerminalOwnerId !== undefined) return resolveIrDynamicCarrierType(ctx);
    // Top-level collection intentionally keeps the checker-derived direct ABI.
    // Exact IR selection may later stage a dynamic contract on this same
    // allocator-owned callable. Body re-resolution must preserve that exact
    // selected contract instead of re-inferring from syntax or a paired getter.
    const allocated = unitId === undefined ? undefined : ctx.programAbiClassCallables?.functionForUnit(unitId);
    const signature = allocated === undefined ? undefined : ctx.mod.types[allocated.typeIdx];
    const selectedValueType = signature?.kind === "func" ? signature.params[1] : undefined;
    if (selectedValueType !== undefined) return selectedValueType;
  }
  return nativeTypeOfDeclaration(ctx.checker, param) ?? resolveWasmType(ctx, ctx.checker.getTypeAtLocation(param));
}

/** Collect all function declarations and interfaces */
/** Collect a class declaration or class expression: register struct type, constructor, and methods */
export function collectClassDeclaration(
  ctx: CodegenContext,
  decl: ts.ClassDeclaration | ts.ClassExpression,
  syntheticName?: string,
): void {
  const className = syntheticName ?? decl.name!.text;
  ctx.classSet.add(className);
  ctx.classDeclarationMap.set(className, decl);

  // (#2023) Assign a stable new.target class-id so `new C()` sites and
  // `new.target === C` comparisons agree on the id. Only when the program uses
  // new.target at all (otherwise no machinery is emitted).
  if (ctx.usesNewTarget) {
    getOrAssignClassNewTargetId(ctx, className);
  }

  // Register the class .name value for ES-spec compliance
  // Named class expressions keep their declared name (class X {} → name = "X")
  // Anonymous class expressions get the variable name (const C = class {} → name = "C")
  const esName = decl.name ? decl.name.text : (syntheticName ?? "");
  ctx.functionNameMap.set(className, esName);

  // For class expressions, map the TS symbol name to the synthetic class name
  // so that resolveStructName and compileNewExpression can find the struct
  if (syntheticName) {
    const tsType = ctx.checker.getTypeAtLocation(decl);
    const symbolName = tsType.getSymbol()?.name;
    if (symbolName && symbolName !== syntheticName) {
      ctx.classExprNameMap.set(symbolName, syntheticName);
    }
  }

  // Detect parent class via heritage clauses (extends)
  let parentClassName: string | undefined;
  let parentStructTypeIdx: number | undefined;
  let parentFields: FieldDef[] = [];
  if (decl.heritageClauses) {
    for (const clause of decl.heritageClauses) {
      if (clause.token === ts.SyntaxKind.ExtendsKeyword && clause.types.length > 0) {
        const baseExpr = clause.types[0]!.expression;
        if (ts.isIdentifier(baseExpr)) {
          // (#4291) The local import spelling is not the class identity. Hono's
          // published base is declared as `var Hono = class _Hono {}`, exported
          // as `HonoBase`, and imported through that alias. Resolve the exact
          // class-expression declaration so the derived struct is registered
          // as a subtype of the synthetic base struct whose bodies actually run.
          parentClassName = exactClassExpressionTypeName(ctx, ctx.checker.getTypeAtLocation(baseExpr)) ?? baseExpr.text;
          // Guard against circular inheritance (e.g., class X extends X)
          if (parentClassName === className) {
            parentClassName = undefined;
            break;
          }
          parentStructTypeIdx = ctx.structMap.get(parentClassName);
          parentFields = ctx.structFields.get(parentClassName) ?? [];
          // Record parent-child relationship
          ctx.classParentMap.set(className, parentClassName);
          // (#2620) A subclass of a native-collection builtin (Set/Map/WeakMap/
          // WeakSet) under nativeStrings (`--target standalone`/`wasi`) cannot
          // take the host-constructible path below: there is no JS host, so
          // `super(...)`/`new Sub()` lowering to `__new_<Parent>` would leak an
          // unsatisfiable `env::__new_Set` import (defect A), and the synthetic
          // `<Class>_<method>` accessor desyncs across the late-import shift
          // (defect B — the #2043 invalid-Wasm class, e.g. `MySet_has`/`_size`
          // baking a `-1` global / a stale call funcIdx).
          //
          // (#3972) NARROWED to property/accessor declarations, deliberately NOT
          // deleted, and narrowed to the shape MEASURED to be broken rather than
          // a guessed one. Defect A is fixed at the root:
          // `emitStandaloneCollectionSuperCtor` gives `super()` a DEFINED `$Map`
          // constructor, so `class Sub extends Set {}` emits no import at all —
          // and with no late import there is no reorder, so defect B cannot
          // arise from construction either. A bare subclass plus an inherited
          // `s.add(1)` also stays host-free (the brand-stamped `$Map` is what
          // makes the value-representation dispatch succeed), so declared
          // methods and explicit constructors are allowed. A declared FIELD or
          // ACCESSOR still traps, which is a family-wide defect the earlier
          // Array/TypedArray rungs ship unguarded.
          //
          // Full rationale, the two measurements that set this boundary, and the
          // terminal fix: see standalone-subclass-ctors.ts (the note above
          // `resolveStandaloneSubclassBuiltinCtor`). Do NOT widen this back to
          // "any non-empty body" and do NOT drop it while the field defect
          // stands. gc/host mode is unaffected: the externClass host path
          // handles the subclass there.
          const declaresFieldOrAccessor = decl.members.some(
            (m) => ts.isPropertyDeclaration(m) || ts.isGetAccessorDeclaration(m) || ts.isSetAccessorDeclaration(m),
          );
          if (
            parentStructTypeIdx === undefined &&
            ctx.nativeStrings &&
            isNativeCollectionBuiltin(parentClassName) &&
            declaresFieldOrAccessor
          ) {
            reportError(
              ctx,
              decl,
              `Codegen error: 'class ${className} extends ${parentClassName}' with a declared ` +
                `property or accessor is not yet supported in --target standalone (#2620/#3972). ` +
                `Construction and inherited methods are native now — an empty-bodied ` +
                `'class ${className} extends ${parentClassName} {}', declared methods, and an ` +
                `explicit constructor all compile and run host-free — but instance FIELD storage on ` +
                `an externref-backed builtin subclass is not implemented, and would trap at runtime ` +
                `rather than fail here. Drop the field/accessor, use ${parentClassName} directly, or ` +
                `recompile without --target standalone.`,
            );
            // Skip the externref-backed marking so the host-leak/invalid-Wasm
            // path is never entered; the queued error fails the compile.
            break;
          }
          // (#2029 → RESOLVED by #3972) A Number/Boolean subclass used to be
          // refused here for an ABI mismatch (the standalone `__new_Number`
          // internal takes an f64, the `<Class>_new` forwarder passes an
          // externref → invalid Wasm). `emitStandaloneWrapperSuperCtor` removes
          // the mismatch at the root, so the refusal is RETIRED rather than
          // narrowed — unlike the #2620 collection refusal above, which still
          // guards a real gap. See standalone-subclass-ctors.ts.
          //
          // (#1366a/#4534) Detect a host-constructible builtin OR an extern
          // class parent (for example node:events' EventEmitter). Such
          // subclasses get an externref-backed instance: the constructor
          // returns externref and `super(...)` lowers to the parent's actual
          // extern-class constructor import. We deliberately keep
          // parentStructTypeIdx undefined so the existing "root struct" path
          // still fires for any user-class collection bookkeeping (struct
          // registration, tag).
          const isExternClassParent = ctx.externClasses.has(parentClassName) && !(ctx.standalone || ctx.wasi);
          if (
            parentStructTypeIdx === undefined &&
            (isHostConstructibleBuiltin(parentClassName) || isExternClassParent)
          ) {
            ctx.classBuiltinParentMap.set(className, parentClassName);
            ctx.classExternrefBackedSet.add(className);
          } else if (
            ctx.classExternrefBackedSet.has(parentClassName) &&
            ctx.classBuiltinParentMap.has(parentClassName)
          ) {
            // (#2188 follow-up) Multi-level user Error chain: the direct parent is
            // itself a user class that is externref-backed by a builtin Error
            // ancestor (e.g. `class D extends A {}` where `A extends Error`).
            // The parent carries a vestigial struct slot, so we do NOT gate on
            // `parentStructTypeIdx === undefined` here — the discriminator is the
            // parent's externref-backing, not its struct presence. `super()` must
            // thread through the SAME builtin ancestor's `__new_<builtin>` so D is
            // constructed as a real `$Error_struct` (carrying the builtin Error
            // `$tag`, `.message`, catchability, and `instanceof Error`) instead of
            // chaining through A's user `_init`, which leaves D un-tagged. Parents
            // are collected in source order before their children, so the
            // ancestor's mapping is already present; propagate the builtin
            // ANCESTOR name (not the immediate parent).
            const builtinAncestor = ctx.classBuiltinParentMap.get(parentClassName)!;
            ctx.classBuiltinParentMap.set(className, builtinAncestor);
            ctx.classExternrefBackedSet.add(className);
          }
          // Mark parent struct as non-final so it can be extended
          if (parentStructTypeIdx !== undefined) {
            const parentTypeDef = ctx.mod.types[parentStructTypeIdx] as StructTypeDef;
            if (parentTypeDef && parentTypeDef.superTypeIdx === undefined) {
              // Mark parent as extensible (superTypeIdx = -1 means "sub with no super")
              parentTypeDef.superTypeIdx = -1;
            }
          }
        }
      }
    }
  }

  // Pre-register the struct type index BEFORE resolving field types.
  // This allows self-referencing fields (e.g. `next: ListNode | null` in class ListNode)
  // to resolve to `ref null $structTypeIdx` instead of falling back to externref.
  // WasmGC supports recursive types natively via rec groups.
  const structTypeIdx = ctx.mod.types.length;
  const placeholderDef: StructTypeDef = { kind: "struct", name: className, fields: [] };
  ctx.mod.types.push(placeholderDef);
  ctx.structMap.set(className, structTypeIdx);
  ctx.typeIdxToStructName.set(structTypeIdx, className);

  // Find the constructor to determine struct fields from `this.x = ...` assignments
  const ctor = findConstructorImplementation(decl);
  const ownFields: FieldDef[] = [];
  // (#3673) Declared instance properties, by name — the constructor-assignment
  // pass below needs the DECLARATION to see an explicit native annotation.
  const declaredPropertyByName = new Map<string, ts.PropertyDeclaration>();
  for (const member of decl.members) {
    if (!ts.isPropertyDeclaration(member) || !member.name || hasStaticModifier(member)) continue;
    const declaredName = resolveClassMemberName(ctx, member.name);
    if (declaredName !== undefined) declaredPropertyByName.set(declaredName, member);
  }

  if (ctor?.body) {
    for (const stmt of ctor.body.statements) {
      // Skip super() calls — they don't define new fields
      if (
        ts.isExpressionStatement(stmt) &&
        ts.isCallExpression(stmt.expression) &&
        stmt.expression.expression.kind === ts.SyntaxKind.SuperKeyword
      ) {
        continue;
      }
      if (
        ts.isExpressionStatement(stmt) &&
        ts.isBinaryExpression(stmt.expression) &&
        stmt.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(stmt.expression.left) &&
        stmt.expression.left.expression.kind === ts.SyntaxKind.ThisKeyword
      ) {
        const rawName = stmt.expression.left.name.text;
        const fieldName = ts.isPrivateIdentifier(stmt.expression.left.name) ? "__priv_" + rawName.slice(1) : rawName;
        // Skip if this field is already defined in parent
        if (parentFields.some((f) => f.name === fieldName)) continue;
        const fieldTsType = ctx.checker.getTypeAtLocation(stmt.expression.left);
        // (#3673) A `this.x = …` in the constructor mints the field BEFORE the
        // property-declaration loop below runs, so the field's declared native
        // annotation (`pos: i32;`) must be consulted HERE too — otherwise a
        // class that both declares and constructor-assigns its fields (the
        // ordinary TypeScript shape) silently keeps the f64 slot while its
        // locals narrow, which measures WORSE than no narrowing at all.
        const fieldType =
          nativeTypeOfDeclaration(ctx.checker, declaredPropertyByName.get(fieldName)) ??
          resolveWasmType(ctx, fieldTsType);
        if (!ownFields.some((f) => f.name === fieldName)) {
          ownFields.push({ name: fieldName, type: fieldType, mutable: true });
        }
      }
    }
  }

  // Also collect fields from property declarations (class Point { x: number; y: number; })
  // Skip static properties — they become module globals, not struct fields
  for (const member of decl.members) {
    if (ts.isPropertyDeclaration(member) && member.name) {
      const fieldName = resolveClassMemberName(ctx, member.name);
      if (fieldName === undefined) continue; // dynamic computed name — skip
      if (hasStaticModifier(member)) continue; // handled below
      // Skip if this field is already defined in parent
      if (parentFields.some((f) => f.name === fieldName)) continue;
      if (!ownFields.some((f) => f.name === fieldName)) {
        const fieldTsType = ctx.checker.getTypeAtLocation(member);
        // (#3673) `pos: i32;` pins the STRUCT FIELD's Wasm type. Whole-chain:
        // narrowing locals without the fields they flow into measurably
        // pessimises (see the issue's round-34 table), so the field, the
        // params and the locals must move together.
        const fieldType = nativeTypeOfDeclaration(ctx.checker, member) ?? resolveWasmType(ctx, fieldTsType);
        ownFields.push({ name: fieldName, type: fieldType, mutable: true });
      }
    }
  }

  // Build full fields list: parent fields first, then own fields
  const fields: FieldDef[] = [...parentFields, ...ownFields];

  // Widen non-null ref fields to ref_null so the constructor can create the
  // struct with ref.null default values before assigning real values.
  // Without this, struct.new would require non-null refs for fields that
  // haven't been initialized yet, causing a Wasm validation error.
  for (const field of fields) {
    if (field.type.kind === "ref") {
      field.type = { kind: "ref_null", typeIdx: field.type.typeIdx };
    }
  }

  // Register the struct type with optional super-type
  // Assign a unique class tag for instanceof support
  const classTag = ctx.classTagCounter++;
  ctx.classTagMap.set(className, classTag);

  // Add hidden __tag field at the beginning for instanceof discrimination
  // Only for root classes — child classes inherit __tag via parentFields.
  // Also treat as root when extending a built-in (parentClassName set but no
  // struct type registered), since built-ins have no Wasm struct fields to inherit.
  if (!parentClassName || parentStructTypeIdx === undefined) {
    fields.unshift({ name: "__tag", type: { kind: "i32" }, mutable: false });

    // (#2158 / #2009) Structural-collision guard. An empty class root struct
    // is exactly `(struct (field $__tag i32))`. The native-string supertype
    // `$AnyString` is also a single-i32-field open struct
    // (`(struct (field $len i32))`). When such a class is a hierarchy ROOT
    // (it has subclasses, so it is left non-final/open), WasmGC iso-recursive
    // canonicalization merges it with `$AnyString` — both are structurally
    // identical open singletons. The class's (final) subclasses then become
    // subtypes of `$AnyString`, so `ref.test $AnyString` on a subclass
    // instance (or class-object singleton) returns TRUE. That false positive
    // drives the standalone `===` / `typeof` string arm to
    // `ref.cast $AnyString` + `__str_flatten` on a non-string struct →
    // `RuntimeError: illegal cast`, breaking every strict-equality and
    // string-typeof over a subclass value in --target standalone (a large
    // slice of the #2158 class/prototype residual). Lone empty classes do not
    // hit this because `markLeafStructsFinal` makes them `final`, and a final
    // struct is not subtype-compatible with the non-final `$AnyString`.
    //
    // Fix: append a hidden immutable sentinel i32 so the root struct is
    // `(struct (field i32) (field i32))` — structurally distinct from the
    // single-field `$AnyString`, breaking the canonical merge. Appended LAST
    // so every existing positional `fieldIdx` for real instance fields is
    // unaffected; constructors / lazy proto+class-object inits iterate the
    // field list and default it to 0 automatically. Cost: +4 bytes only on
    // empty class instances (the rare case). A class with any instance field
    // is already structurally distinct and needs no sentinel.
    if (fields.length === 1) {
      fields.push({ name: "__shape_brand", type: { kind: "i32" }, mutable: false });
    }

    // (#802 Slice B) Conditional dynamic-prototype slot. ONLY hierarchy roots
    // the scanForDynamicProto prescan proved to be proto-mutation receivers
    // (Object.setPrototypeOf / Reflect.setPrototypeOf / `o.__proto__ =` on an
    // instance of this hierarchy) get one appended `(field $__proto__ (mut
    // externref))`. Appended LAST — after __tag, all real fields, and any
    // __shape_brand — so every existing positional fieldIdx is unchanged, and
    // every class-struct `struct.new` site (the ctor alloc loops below, the
    // lazy proto/class-object singleton inits in expressions/extern.ts, the
    // object-literal struct path) iterates the field list and defaults it to
    // `ref.null.extern` automatically: the operand count stays correct BY
    // CONSTRUCTION. That conditionality + append-last is what makes this safe
    // where #799a's unconditional prepend-to-everything regressed −2,788.
    // `null` in this field means "never dynamically set" (readers fall back to
    // the compile-time prototype); an EXPLICIT `setPrototypeOf(o, null)` stores
    // the dynamic-proto sentinel instead (see src/codegen/dynamic-proto.ts).
    // Standalone-only: gc/host models dynamic protos via the host
    // `_wasmStructProto` WeakMap sidecar and its structs are untouched.
    if (ctx.standalone && ctx.dynamicProtoClasses.has(className) && !fields.some((f) => f.name === "__proto__")) {
      fields.push({ name: "__proto__", type: { kind: "externref" }, mutable: true });
    }
  }

  // Update the placeholder struct type with resolved fields
  const structDef: StructTypeDef = { kind: "struct", name: className, fields };
  if (parentStructTypeIdx !== undefined) {
    structDef.superTypeIdx = parentStructTypeIdx;
  }
  commitClassStructLayout(ctx, decl, className, structTypeIdx, structDef, fields);

  // Register a prototype singleton global (externref, lazily initialized)
  // Used by ClassName.prototype and Object.getPrototypeOf(instance).
  {
    const protoGlobalIdx = nextModuleGlobalIdx(ctx);
    ctx.mod.globals.push({
      name: `__proto_${className}`,
      type: { kind: "externref" },
      mutable: true,
      init: [{ op: "ref.null.extern" }],
    });
    ctx.protoGlobals.set(className, protoGlobalIdx);
  }

  // (#1395) Register a class-object singleton global (externref, lazily
  // initialized). The bare class identifier `C` resolves to this global,
  // giving `Object.getOwnPropertyDescriptor(C, "m")` a real receiver to
  // inspect. Skip for externref-backed builtin subclasses (#1366a) — those
  // don't have a `$ClassName` WasmGC struct.
  if (!ctx.classBuiltinParentMap.has(className)) {
    const classObjectGlobalIdx = nextModuleGlobalIdx(ctx);
    ctx.mod.globals.push({
      name: `__class_${className}`,
      type: { kind: "externref" },
      mutable: true,
      init: [{ op: "ref.null.extern" }],
    });
    ctx.classObjectGlobals.set(className, classObjectGlobalIdx);
  }

  // Register constructor function: takes ctor params, returns (ref $structTypeIdx)
  const ctorParams: ValType[] = [];
  const ctorName = `${className}_new`;
  // (#1833) For externref-backed subclasses with no explicit constructor
  // (`class Sub extends DataView {}`), synthesize the spec's implicit
  // `constructor(...args) { super(...args); }` as an externref forwarder whose
  // arity matches the parent constructor shape. Missing caller args are padded
  // as JS undefined and stripped by the runtime's `__new_<Parent>` resolver.
  // (#2086) Synthesize the implicit derived-ctor parameter prefix from the one
  // shared rule. `implicitForwarderArity` (#1833, externref-backed built-in
  // parent) and `implicitStructCtorParams` (#2082, WasmGC-struct parent) are
  // the two lanes; the fctx-build phase below reuses the same helper.
  const {
    implicitForwarderArity,
    implicitStructCtorParams,
    prefixParams: implicitPrefixParams,
  } = computeImplicitDerivedCtorPrefix(ctx, decl, className, ctor);
  ctorParams.push(...implicitPrefixParams.map((p) => p.type));
  if (ctor) {
    for (let i = 0; i < ctor.parameters.length; i++) {
      const param = ctor.parameters[i]!;
      if (param.dotDotDotToken) {
        // Rest parameter: ...args: T[] -> single (ref $__vec_elemKind) param (#382)
        const paramType = ctx.checker.getTypeAtLocation(param);
        const typeArgs = ctx.checker.getTypeArguments(paramType as ts.TypeReference);
        const elemTsType = typeArgs[0];
        const elemType: ValType = elemTsType ? resolveWasmType(ctx, elemTsType) : { kind: "f64" };
        const elemKey =
          elemType.kind === "ref" || elemType.kind === "ref_null"
            ? `ref_${(elemType as { typeIdx: number }).typeIdx}`
            : elemType.kind;
        const vecTypeIdx = getOrRegisterVecType(ctx, elemKey, elemType);
        const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
        ctorParams.push({ kind: "ref_null", typeIdx: vecTypeIdx });
        ctx.funcRestParams.set(ctorName, {
          restIndex: i,
          elemType,
          arrayTypeIdx: arrTypeIdx,
          vecTypeIdx,
        });
      } else {
        const paramType = ctx.checker.getTypeAtLocation(param);
        // (#3673) explicit native annotation pins the constructor parameter type
        let wasmType = nativeTypeOfDeclaration(ctx.checker, param) ?? resolveWasmType(ctx, paramType);
        // Widen ref to ref_null for params with defaults
        if (param.initializer && wasmType.kind === "ref") {
          wasmType = { kind: "ref_null", typeIdx: (wasmType as any).typeIdx };
        }
        ctorParams.push(wasmType);
      }
    }
  }
  // (#1366a) Externref-backed subclasses (extends Error/TypeError/...) have
  // a host-created instance, so the constructor returns externref instead of
  // a (ref $struct).
  const isExternrefBackedClass = ctx.classExternrefBackedSet.has(className);
  const ctorResults: ValType[] = isExternrefBackedClass
    ? [{ kind: "externref" }]
    : [{ kind: "ref", typeIdx: structTypeIdx }];
  if (ctor) {
    registerClassOptionalParams(ctx, ctorName, ctor.parameters, ctorParams);
  } else if (implicitStructCtorParams) {
    // #2082: the implicit ctor inherits the forwarded parent params' optionality
    // so the call site sets `__argc` and the default-value checks fire.
    registerClassOptionalParams(ctx, ctorName, implicitStructCtorParams, ctorParams, implicitForwarderArity);
  }
  const ctorTypeIdx = addFuncType(ctx, ctorParams, ctorResults, `${className}_new_type`);
  const ctorFuncIdx = mintDefinedFunc(ctx);
  // (#1983) collision-free key — also the wasm display name so the funcByName
  // body-fill lookup doesn't collide with a user `function ClassName_new()`.
  const ctorKey = classMemberFuncKey(ctx, ctorName);
  ctx.funcMap.set(ctorKey, ctorFuncIdx);

  pushProgramAbiClassCallable(
    ctx,
    isExternrefBackedClass ? (ctor ?? decl) : decl,
    isExternrefBackedClass ? "unit" : "constructor-new",
    ctorFuncIdx,
    {
      name: ctorKey,
      typeIdx: ctorTypeIdx,
      locals: [],
      body: [],
      exported: false,
    },
  );

  // (#2637 B2.1/B2.3) For a `class … extends Promise` WITH a user constructor,
  // pre-register a SECOND constructor body `${className}_new__onhost`. It has
  // the SAME parameter list as `${className}_new` but returns externref and,
  // when filled (see `compileConstructorFunction(..., "onHost")`), binds its
  // `this`/`$__self` to the host-provided NewPromiseCapability promise
  // (`__current_this`) instead of allocating a fresh Promise via
  // `__new_Promise`. The combinator path registers a no-capture closure over
  // THIS function with the runtime (`__register_promise_subclass_ctor`); the
  // direct-new `${className}_new` body (the B1 path) is left untouched so it
  // does not regress. Pre-registering here (Phase 2) keeps the funcIdx stable
  // for the closure materialization that happens during Phase-3 body
  // compilation (`emitPromiseSubclassCtor`), regardless of compile order.
  if (isPromiseSubclassWithUserCtor(ctx, className, ctor)) {
    const onHostName = `${ctorName}__onhost`;
    const onHostTypeIdx = addFuncType(ctx, ctorParams, [{ kind: "externref" }], `${onHostName}_type`);
    const onHostFuncIdx = mintDefinedFunc(ctx);
    const onHostKey = classMemberFuncKey(ctx, onHostName);
    ctx.funcMap.set(onHostKey, onHostFuncIdx);
    pushProgramAbiClassCallable(ctx, decl, "promise-subclass-onhost", onHostFuncIdx, {
      name: onHostKey,
      typeIdx: onHostTypeIdx,
      locals: [],
      body: [],
      exported: false,
    });
    // Mirror the ctor's optional / rest call-site metadata under the onhost
    // name too, so the onhost body's default-param machinery (param-index
    // based) and any super-arg forwarding behave identically to `_new`.
    const ctorOptionals = ctx.funcOptionalParams.get(ctorName);
    if (ctorOptionals) ctx.funcOptionalParams.set(onHostName, ctorOptionals);
    const ctorRest = ctx.funcRestParams.get(ctorName);
    if (ctorRest) ctx.funcRestParams.set(onHostName, ctorRest);
  }

  // (#1965) Register the constructor-init function `${className}_init`:
  // `(...ctorParams, self: ref $struct) -> (ref $struct)`. It carries the
  // parameter defaults, field initializers, and the full constructor BODY,
  // operating on a caller-allocated instance. `${className}_new` reduces to
  // alloc + tail-call init, and `super(args)` in a derived constructor
  // becomes a real `call ${Parent}_init(args..., self)` — the parent ctor
  // body finally executes (previously super() positionally copied args onto
  // parent struct fields and dropped the body). Self is the LAST param so
  // ctor param indices are identical in `_new` and `_init`, which keeps the
  // optional/default machinery (param-index-based) working unchanged.
  // Externref-backed classes (extends Error etc.) keep the single-function
  // host-forwarder shape — no init split.
  if (!isExternrefBackedClass) {
    const initName = `${className}_init`;
    const initParams: ValType[] = [...ctorParams, { kind: "ref", typeIdx: structTypeIdx }];
    const initTypeIdx = addFuncType(ctx, initParams, [{ kind: "ref", typeIdx: structTypeIdx }], `${initName}_type`);
    const initFuncIdx = mintDefinedFunc(ctx);
    const initKey = classMemberFuncKey(ctx, initName); // (#1983) collision-free key + display name
    ctx.funcMap.set(initKey, initFuncIdx);
    pushProgramAbiClassCallable(ctx, ctor ?? decl, "unit", initFuncIdx, {
      name: initKey,
      typeIdx: initTypeIdx,
      locals: [],
      body: [],
      exported: false,
    });
    // Mirror the ctor's optional-param / rest-param call-site metadata so
    // super() call sites (which call init directly) pad and set __argc the
    // same way `new C(...)` sites do for `${className}_new`.
    const ctorOptionals = ctx.funcOptionalParams.get(ctorName);
    if (ctorOptionals) ctx.funcOptionalParams.set(initName, ctorOptionals);
    const ctorRest = ctx.funcRestParams.get(ctorName);
    if (ctorRest) ctx.funcRestParams.set(initName, ctorRest);
  }

  // Register method functions (own methods defined on this class).
  // Bodyless overload signatures and abstract methods are type-only.
  const ownMethodNames = new Set<string>();
  // Populate both method-kind sets before minting any function keys. A class
  // may legally define `static m()` alongside `m()`; the static key helper
  // needs to see the instance member even when the static declaration appears
  // first in source order.
  for (const member of decl.members) {
    if (!ts.isMethodDeclaration(member) || !member.name || !member.body) continue;
    const methodName = resolveClassMemberName(ctx, member.name);
    if (methodName === undefined) continue;
    const fullName = `${className}_${methodName}`;
    if (hasStaticModifier(member)) ctx.staticMethodSet.add(fullName);
    else ctx.classMethodSet.add(fullName);
  }
  for (const member of decl.members) {
    if (ts.isMethodDeclaration(member) && member.name) {
      const methodName = resolveClassMemberName(ctx, member.name);
      if (methodName === undefined) continue; // dynamic computed name — skip
      ownMethodNames.add(methodName);

      if (!member.body) continue;

      const fullName = `${className}_${methodName}`;
      const isStatic = hasStaticModifier(member);

      // ES2015 14.5.14 step 21: static methods cannot be named 'prototype'
      if (isStatic && methodName === "prototype") {
        ctx.classThrowsOnEval.add(className);
      }

      if (isStatic) {
        ctx.staticMethodSet.add(fullName);
      } else {
        ctx.classMethodSet.add(fullName);
      }

      // Track generator methods (method*)
      const isGeneratorMethod = member.asteriskToken !== undefined;
      if (isGeneratorMethod) {
        ctx.generatorFunctions.add(fullName);
      }

      // (#1983) check the relocated key so a user `function ClassName_m()` does
      // not look like an already-registered method and suppress the real one.
      // Static and instance members intentionally use distinct keys when their
      // source names collide.
      const memberKind = isStatic ? "static" : "instance";
      if (ctx.funcMap.has(classMemberFuncKey(ctx, fullName, memberKind))) continue;

      // Static methods have no self parameter; host-backed instance methods
      // receive the real JS object as externref (see the body compilation
      // below), while ordinary classes retain the WasmGC ref ABI.
      const methodParams: ValType[] = isStatic
        ? []
        : [
            ctx.classExternrefBackedSet.has(className)
              ? { kind: "externref" }
              : { kind: "ref", typeIdx: structTypeIdx },
          ];
      for (const param of member.parameters) {
        const paramType = ctx.checker.getTypeAtLocation(param);
        if (param.dotDotDotToken) {
          // A class method's rest parameter is represented by the same hidden
          // WasmGC vector ABI as a free function's rest parameter.  Keep the
          // call-site metadata in sync with that ABI so direct method calls
          // materialize an empty vector for `m()` (and pack trailing args)
          // instead of passing the nullable vector parameter as `null`.
          const typeArgs = ctx.checker.getTypeArguments(paramType as ts.TypeReference);
          const elemTsType = typeArgs[0];
          const elemType: ValType = elemTsType ? resolveWasmType(ctx, elemTsType) : { kind: "f64" };
          const elemKey =
            elemType.kind === "ref" || elemType.kind === "ref_null"
              ? `ref_${(elemType as { typeIdx: number }).typeIdx}`
              : elemType.kind;
          const vecTypeIdx = getOrRegisterVecType(ctx, elemKey, elemType);
          const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
          methodParams.push({ kind: "ref_null", typeIdx: vecTypeIdx });
          ctx.funcRestParams.set(fullName, {
            restIndex: isStatic ? member.parameters.indexOf(param) : member.parameters.indexOf(param),
            elemType,
            arrayTypeIdx: arrTypeIdx,
            vecTypeIdx,
          });
          continue;
        }
        // (#3673) explicit native annotation pins the parameter type
        let wasmType = nativeTypeOfDeclaration(ctx.checker, param) ?? resolveWasmType(ctx, paramType);
        // Widen ref to ref_null for params with defaults (caller passes ref.null as sentinel)
        if (param.initializer && wasmType.kind === "ref") {
          wasmType = { kind: "ref_null", typeIdx: (wasmType as any).typeIdx };
        }
        methodParams.push(wasmType);
      }
      registerClassOptionalParams(ctx, fullName, member.parameters, methodParams, isStatic ? 0 : 1);

      // Detect async methods — unwrap Promise<T> to T for Wasm return type
      // Exclude async generators: they return AsyncGenerator objects, not Promises.
      const isAsyncMethod = member.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ?? false;
      if (isAsyncMethod && !isGeneratorMethod) {
        ctx.asyncFunctions.add(fullName);
      }

      const sig = ctx.checker.getSignatureFromDeclaration(member);
      let methodResults: ValType[] = [];
      if (isGeneratorMethod) {
        // (#2571) In a no-JS-host target, a native-capable generator method
        // returns its `$GenState_*` struct (the lazy native state machine),
        // NOT the eager-buffer `externref` Generator object. Register it here —
        // during the collection pass — so the state-struct type exists and the
        // method's wasm signature carries the right result type (mirrors the
        // free-function path in declarations.ts:2499). `methodParams` already
        // includes the leading `this` ref for instance methods; mark
        // `synthesizedThis` so `param_this` is minted. The actual factory emit
        // is routed below (the generator-method emit block). JS-host mode keeps
        // the externref Generator object (eager-buffer path) — byte-identical.
        const noJsHost = ctx.standalone || ctx.wasi;
        let nativeGen = null;
        if (noJsHost && !isAsyncMethod && isNativeGeneratorCandidate(ctx, member)) {
          nativeGen = registerNativeGenerator(
            ctx,
            member,
            classMemberFuncKey(ctx, fullName, memberKind),
            methodParams,
            /* synthesizedThis */ !isStatic,
          );
        }
        methodResults = nativeGen ? [{ kind: "ref", typeIdx: nativeGen.stateTypeIdx }] : [{ kind: "externref" }];
      } else if (sig) {
        let retType = ctx.checker.getReturnTypeOfSignature(sig);
        if (isAsyncMethod) {
          retType = unwrapPromiseType(retType, ctx.checker);
        }
        if (!isVoidType(retType)) {
          // (#3673) `next(): i32` pins the result type syntactically.
          methodResults = [nativeTypeFromTypeNode(ctx.checker, member.type) ?? resolveWasmType(ctx, retType)];
        }
      }

      // Track methods that read `arguments` (#1053) so callers can
      // populate the __extras_argv global with runtime args beyond the
      // formal param count.
      if (needsImplicitArgumentsObject(member)) {
        ctx.funcUsesArguments.add(fullName);
      }

      const methodTypeIdx = addFuncType(ctx, methodParams, methodResults, `${fullName}_type`);
      const methodFuncIdx = mintDefinedFunc(ctx);
      // (#1983) Use the collision-free key for the funcMap entry AND the wasm
      // display name, so the `funcByName` body-fill lookup (which keys on the
      // display name) does not collide with a user `function ClassName_m()`.
      const methodKey = classMemberFuncKey(ctx, fullName, memberKind);
      ctx.funcMap.set(methodKey, methodFuncIdx);
      // (#4440) The method mint sites key everything by `fullName`; record the
      // node under the same key so they can read §15.1.5 / §10.2.9 from it.
      recordFnMetaMemberDeclaration(ctx, fullName, member);

      pushProgramAbiClassCallable(ctx, member, "unit", methodFuncIdx, {
        name: methodKey,
        typeIdx: methodTypeIdx,
        locals: [],
        body: [],
        exported: false,
      });
    }
  }

  // Register getter/setter accessor functions
  for (const member of decl.members) {
    // ES2015 14.5.14 step 21: static accessors cannot be named 'prototype'
    if (
      (ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) &&
      member.name &&
      hasStaticModifier(member)
    ) {
      const accName = resolveClassMemberName(ctx, member.name);
      if (accName === "prototype") {
        ctx.classThrowsOnEval.add(className);
      }
    }

    if (ts.isGetAccessorDeclaration(member) && member.name) {
      const propName = resolveClassMemberName(ctx, member.name);
      if (propName === undefined) continue; // dynamic computed name — skip
      const accessorKey = `${className}_${propName}`;
      ctx.classAccessorSet.add(accessorKey);
      if (hasStaticModifier(member)) {
        ctx.staticAccessorSet.add(accessorKey);
      }

      const getterName = `${className}_get_${propName}`;
      // Skip if a function with this name is already registered (e.g., when
      // both a static and instance getter share the same computed property name,
      // they produce the same function name — avoid creating duplicates that
      // leave empty-body placeholders causing "stack fallthru" validation errors).
      if (ctx.funcMap.has(classMemberFuncKey(ctx, getterName))) continue; // (#1983)
      // Getter takes self, returns the accessor return type
      const getterParams: ValType[] = [
        ctx.classExternrefBackedSet.has(className) ? { kind: "externref" } : { kind: "ref", typeIdx: structTypeIdx },
      ];
      const sig = ctx.checker.getSignatureFromDeclaration(member);
      let getterResults: ValType[] = [];
      if (sig) {
        const retType = ctx.checker.getReturnTypeOfSignature(sig);
        if (!isVoidType(retType)) {
          getterResults = [nativeTypeFromTypeNode(ctx.checker, member.type) ?? resolveWasmType(ctx, retType)];
        }
      }

      const getterTypeIdx = addFuncType(ctx, getterParams, getterResults, `${getterName}_type`);
      const getterFuncIdx = mintDefinedFunc(ctx);
      const getterKey = classMemberFuncKey(ctx, getterName); // (#1983) key + display name
      ctx.funcMap.set(getterKey, getterFuncIdx);
      recordFnMetaMemberDeclaration(ctx, getterName, member); // (#4440) `get p`

      pushProgramAbiClassCallable(ctx, member, "unit", getterFuncIdx, {
        name: getterKey,
        typeIdx: getterTypeIdx,
        locals: [],
        body: [],
        exported: false,
      });
    }

    if (ts.isSetAccessorDeclaration(member) && member.name) {
      const propName = resolveClassMemberName(ctx, member.name);
      if (propName === undefined) continue; // dynamic computed name — skip
      const accessorKey = `${className}_${propName}`;
      ctx.classAccessorSet.add(accessorKey);
      if (hasStaticModifier(member)) {
        ctx.staticAccessorSet.add(accessorKey);
      }

      const setterName = `${className}_set_${propName}`;
      // Skip if already registered (same collision guard as getter above)
      if (ctx.funcMap.has(classMemberFuncKey(ctx, setterName))) continue; // (#1983)
      // Setter takes self + value, returns void
      const setterParams: ValType[] = [
        ctx.classExternrefBackedSet.has(className) ? { kind: "externref" } : { kind: "ref", typeIdx: structTypeIdx },
      ];
      for (const param of member.parameters) {
        setterParams.push(resolveClassAccessorParameterType(ctx, member, param));
      }
      registerClassOptionalParams(ctx, setterName, member.parameters, setterParams, 1);

      const setterTypeIdx = addFuncType(ctx, setterParams, [], `${setterName}_type`);
      const setterFuncIdx = mintDefinedFunc(ctx);
      const setterKey = classMemberFuncKey(ctx, setterName); // (#1983) key + display name
      ctx.funcMap.set(setterKey, setterFuncIdx);
      recordFnMetaMemberDeclaration(ctx, setterName, member); // (#4440) `set p`

      pushProgramAbiClassCallable(ctx, member, "unit", setterFuncIdx, {
        name: setterKey,
        typeIdx: setterTypeIdx,
        locals: [],
        body: [],
        exported: false,
      });
    }
  }

  // Register inherited methods and accessors: if parent has methods/accessors
  // that child doesn't override, map ChildClass_X → ParentClass_X func index
  if (parentClassName) {
    const ownAccessorNames = new Set<string>();
    for (const member of decl.members) {
      if ((ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) && member.name) {
        const accName = resolveClassMemberName(ctx, member.name);
        if (accName) ownAccessorNames.add(accName);
      }
    }

    // Walk the parent chain to find all inherited methods and accessors
    // Guard against circular inheritance (e.g., class X extends X)
    const visitedAncestors = new Set<string>();
    let ancestor: string | undefined = parentClassName;
    while (ancestor && !visitedAncestors.has(ancestor)) {
      visitedAncestors.add(ancestor);
      // Inherit methods
      for (const [key, funcIdx] of ctx.funcMap) {
        // (#1983) A parent member whose legacy `${ancestor}_${member}` key
        // collided with a user function is registered under the relocated
        // `__cm$${ancestor}_${member}` key. Recover the legacy form first so the
        // prefix-scan below sees inherited members regardless of relocation.
        const legacyKey = key.startsWith("__cm$") ? key.slice("__cm$".length) : key;
        if (legacyKey.startsWith(`${ancestor}_`) && !legacyKey.endsWith("_new") && !legacyKey.endsWith("_type")) {
          const suffix = legacyKey.substring(ancestor.length + 1);
          // Skip constructor-related entries
          if (suffix === "new" || suffix.startsWith("new_") || suffix === "init") continue;
          // Check if this is a getter/setter (get_X or set_X)
          const getMatch = suffix.match(/^get_(.+)$/);
          const setMatch = suffix.match(/^set_(.+)$/);
          if (getMatch || setMatch) {
            // Accessor inheritance
            const accPropName = (getMatch || setMatch)![1]!;
            if (!ownAccessorNames.has(accPropName)) {
              const childFullName = `${className}_${suffix}`;
              const childKey = classMemberFuncKey(ctx, childFullName); // (#1983)
              if (!ctx.funcMap.has(childKey)) {
                setProgramAbiInheritedClassCallableAlias(ctx, decl, childKey, funcIdx);
              }
              // Also inherit accessor set entry
              const parentAccessorKey = `${ancestor}_${accPropName}`;
              const childAccessorKey = `${className}_${accPropName}`;
              if (ctx.classAccessorSet.has(parentAccessorKey) && !ctx.classAccessorSet.has(childAccessorKey)) {
                ctx.classAccessorSet.add(childAccessorKey);
              }
            }
          } else {
            // Regular method — inherit from parent (works for all method names,
            // including those with underscores like my_method) (#799 WI6)
            const childFullName = `${className}_${suffix}`;
            const childKey = classMemberFuncKey(ctx, childFullName); // (#1983)
            if (!ownMethodNames.has(suffix) && !ctx.funcMap.has(childKey)) {
              setProgramAbiInheritedClassCallableAlias(ctx, decl, childKey, funcIdx);
              ctx.classMethodSet.add(childFullName);
            }
          }
        }
      }
      ancestor = ctx.classParentMap.get(ancestor);
    }
  }

  // #1047 — collect own (non-static) method + accessor names so `_wrapForHost`
  // can present `C.prototype` with a method-only own-key set. Instance fields
  // (ownFields) are intentionally excluded — they must NOT appear as own
  // properties of the prototype.
  {
    const protoMethodNames: string[] = [];
    const seen = new Set<string>();
    for (const member of decl.members) {
      if (hasStaticModifier(member)) continue;
      if (
        ts.isMethodDeclaration(member) ||
        ts.isGetAccessorDeclaration(member) ||
        ts.isSetAccessorDeclaration(member)
      ) {
        if (!member.name) continue;
        const n = resolveClassMemberName(ctx, member.name);
        if (n === undefined) continue;
        if (seen.has(n)) continue;
        seen.add(n);
        protoMethodNames.push(n);
      }
    }
    ctx.classMethodNames.set(className, protoMethodNames);
  }

  // (#1395) Collect own static method names — analog of the prototype loop
  // above. Used by `_staticMethodNames` allowlist so
  // `Object.getOwnPropertyDescriptor(C, "m")` returns the spec descriptor for
  // static methods. Inherited statics are intentionally excluded — spec
  // §8.10.6 says `getOwnPropertyDescriptor` returns descriptors only for OWN
  // properties. Static accessors (`static get m()`) are excluded for now —
  // their descriptor shape differs (`get`/`set` vs `value`/`writable`) and
  // they're out of Phase 1 scope.
  {
    const staticMethodNames: string[] = [];
    const seenStatic = new Set<string>();
    for (const member of decl.members) {
      if (!hasStaticModifier(member)) continue;
      if (!ts.isMethodDeclaration(member)) continue;
      if (!member.name) continue;
      const n = resolveClassMemberName(ctx, member.name);
      if (n === undefined) continue;
      if (seenStatic.has(n)) continue;
      seenStatic.add(n);
      staticMethodNames.push(n);
    }
    ctx.classStaticMethodNames.set(className, staticMethodNames);
  }

  // Register static properties as module globals, and queue static `{ ... }`
  // blocks for execution. Both field initializers and static blocks must run
  // in source order during class evaluation (§15.7.10), so we iterate members
  // once and push to the shared `staticInitExprs` queue in declaration order.
  for (const member of decl.members) {
    if (ts.isClassStaticBlockDeclaration(member)) {
      ctx.staticInitExprs.push({ staticBlock: member, className });
      continue;
    }
    if (ts.isPropertyDeclaration(member) && member.name && hasStaticModifier(member)) {
      const propName = resolveClassMemberName(ctx, member.name);
      if (propName === undefined) continue; // dynamic computed name — skip
      const fullName = `${className}_${propName}`;
      if (ctx.staticProps.has(fullName)) continue; // skip if already registered

      const propTsType = ctx.checker.getTypeAtLocation(member);
      const wasmType = nativeTypeOfDeclaration(ctx.checker, member) ?? resolveWasmType(ctx, propTsType);

      // Build null/zero initializer for the global
      const init: Instr[] =
        wasmType.kind === "f64"
          ? [{ op: "f64.const", value: 0 }]
          : wasmType.kind === "i32"
            ? [{ op: "i32.const", value: 0 }]
            : wasmType.kind === "i64"
              ? [{ op: "i64.const", value: 0n }]
              : wasmType.kind === "ref_null" || wasmType.kind === "ref"
                ? [
                    {
                      op: "ref.null",
                      typeIdx: (wasmType as { typeIdx: number }).typeIdx,
                    },
                  ]
                : [{ op: "ref.null.extern" }];

      // Widen non-nullable ref to ref_null so the global can hold null initially
      const globalType: ValType =
        wasmType.kind === "ref"
          ? {
              kind: "ref_null",
              typeIdx: (wasmType as { typeIdx: number }).typeIdx,
            }
          : wasmType;

      const globalIdx = nextModuleGlobalIdx(ctx);
      ctx.mod.globals.push({
        name: `__static_${fullName}`,
        type: globalType,
        mutable: true,
        init,
      });
      ctx.staticProps.set(fullName, globalIdx);

      // Store initializer expression for later compilation. (#1395) Carrying
      // `className` lets the init compile loop set `enclosingClassName` +
      // `isStaticContext` on the per-initializer fctx so `this` inside
      // (e.g. `static f = () => this`) resolves to the class-object singleton
      // via `emitLazyClassObjectGet`, NOT to `undefined`.
      if (member.initializer) {
        ctx.staticInitExprs.push({
          globalIdx,
          initializer: member.initializer,
          className,
        });
      }
    }
  }
}

/**
 * For a generic function, find the first call site in the source and resolve
 * concrete param/return types from the checker's instantiated signature.
 * Returns null if no call site is found (function stays with erased types).
 */

export const INTERNAL_FIELD_NAMES = new Set(["__tag", "__proto__"]);

/**
 * Default property flags: writable (bit 0) + enumerable (bit 1) + configurable (bit 2).
 * Matches PROP_FLAG_WRITABLE | PROP_FLAG_ENUMERABLE | PROP_FLAG_CONFIGURABLE from object-ops.ts.
 */
export const PROP_FLAGS_DEFAULT = 0x07;

/**
 * Build the per-shape default property flags table.
 * Iterates all struct types registered via structMap (classes, anonymous objects,
 * interfaces, type aliases) and creates a Uint8Array of default flags for each.
 * One byte per user-visible field; internal fields (__tag) are excluded.
 *
 * This table is purely compile-time metadata with zero runtime overhead.
 * Future subtasks (#797c Object.defineProperty, #797d Object.keys) will
 * emit code that reads from this table at runtime.
 */
export function buildShapePropFlagsTable(ctx: CodegenContext): void {
  for (const [name, typeIdx] of ctx.structMap) {
    const fields = ctx.structFields.get(name);
    if (!fields || fields.length === 0) continue;

    // Count user-visible fields (exclude internal fields)
    const userFields = fields.filter((f) => !INTERNAL_FIELD_NAMES.has(f.name));
    if (userFields.length === 0) continue;

    // All user-visible properties get default flags (writable + enumerable + configurable)
    const flags = new Uint8Array(userFields.length);
    flags.fill(PROP_FLAGS_DEFAULT);

    ctx.shapePropFlags.set(typeIdx, flags);
  }
}

/**
 * Scan all function bodies for ref.func instructions and record their targets.
 *
 * (#4257) `opts.additive` re-runs the scan over the ALREADY-collected set
 * instead of replacing it. The one-shot mid-finalize call happens long before
 * the `__extern_get` / dispatcher body FILLS run, so a `ref.func` whose only
 * occurrence is inside a late-spliced arm was never declared and the module
 * failed validation with "undeclared reference to function #N". Two arms
 * (#2963's method trampolines, #2175's eval callables) had each hand-patched
 * that by pushing their own index; the additive re-scan generalises the repair
 * so a new arm cannot reintroduce the bug. Union, never replace: an entry a
 * caller pushed by hand for a `ref.func` this scan cannot see (element
 * segments, later rewriters) must survive.
 */
export function collectDeclaredFuncRefs(ctx: CodegenContext, opts?: { additive?: boolean }): void {
  const refs = new Set<number>(opts?.additive ? ctx.mod.declaredFuncRefs : []);
  function scanInstrs(instrs: Instr[]): void {
    for (const instr of instrs) {
      if (instr.op === "ref.func") {
        refs.add((instr as { op: "ref.func"; funcIdx: number }).funcIdx);
      }
      // Recurse into nested instruction arrays (if/then/else, block/body, loop, try/catch)
      if ("body" in instr && Array.isArray((instr as any).body)) {
        scanInstrs((instr as any).body);
      }
      if ("then" in instr && Array.isArray((instr as any).then)) {
        scanInstrs((instr as any).then);
      }
      if ("else" in instr && Array.isArray((instr as any).else)) {
        scanInstrs((instr as any).else);
      }
      if ("catches" in instr && Array.isArray((instr as any).catches)) {
        for (const c of (instr as any).catches) {
          if (Array.isArray(c.body)) scanInstrs(c.body);
        }
      }
      if ("catchAll" in instr && Array.isArray((instr as any).catchAll)) {
        scanInstrs((instr as any).catchAll);
      }
    }
  }
  for (const func of ctx.mod.functions) {
    scanInstrs(func.body);
  }
  if (refs.size > 0) {
    // (#1916 S3b) Sort by the RESOLVED absolute index, not the raw handle
    // value. A stable-regime handle (>= STABLE_FUNC_BASE) is numerically huge,
    // so a raw `a - b` sort banishes it to the end and permutes the emitted
    // element segment relative to the all-live baseline. `absoluteFuncIndex`
    // maps both regimes to the current index, so the order is identical whether
    // a producer has flipped to stable minting or not (byte-identity-preserving).
    ctx.mod.declaredFuncRefs = [...refs].sort((a, b) => absoluteFuncIndex(ctx.mod, a) - absoluteFuncIndex(ctx.mod, b));
  }
}

export interface ClassBodyCompileRouting {
  /** Exact physical member names whose direct emitter must not run. */
  readonly skipBodies: ReadonlySet<string>;
  /** Prepared slots whose already-installed IR bodies must remain untouched. */
  readonly preserveSkippedBodies?: ReadonlySet<string>;
  /** Correlation sink populated only after an exact class slot is found. */
  readonly skippedNames: string[];
  /** Authoritative exact body population; names above are compatibility only. */
  readonly skipBodyUnitIds?: ReadonlySet<IrUnitId>;
  readonly preserveSkippedBodyUnitIds?: ReadonlySet<IrUnitId>;
  readonly skippedUnitIds?: IrUnitId[];
  /** Exact non-terminal implicit-constructor support units installed during preparation. */
  readonly skipImplicitConstructorUnitIds?: ReadonlySet<IrUnitId>;
  readonly skippedImplicitConstructorUnitIds?: IrUnitId[];
}

export function skipExactPreparedClassBody(
  ctx: CodegenContext,
  declaration: ts.MethodDeclaration | ts.GetAccessorDeclaration | ts.SetAccessorDeclaration,
  routing: ClassBodyCompileRouting | undefined,
): boolean {
  const unitId = ctx.irPlanningIdentityContext?.unitIdByDeclaration.get(declaration);
  if (unitId === undefined || routing?.skipBodyUnitIds?.has(unitId) !== true) return false;
  const terminal = ctx.irPlanningIdentityContext?.terminalByUnitId.get(unitId);
  const allocated = ctx.programAbiClassCallables?.functionForUnit(unitId);
  if (
    !terminal ||
    terminal.observedKind !== "class-member" ||
    ctx.irPlanningIdentityContext?.declarationByUnitId.get(unitId) !== declaration ||
    !allocated
  ) {
    throw new Error(`exact prepared class body ${unitId} has no observed allocator callable`);
  }
  if (routing.preserveSkippedBodyUnitIds?.has(unitId) !== true) {
    allocated.body = [{ op: "unreachable" }];
  }
  // The legacy declaration walker intentionally reaches a variable-bound
  // class expression through both its binding branch and its recursive
  // anonymous-class scan. Both visits point at the same authoritative AST
  // declaration/UnitId; record the skip once so result correlation measures
  // body ownership rather than traversal multiplicity.
  if (routing.skippedUnitIds && !routing.skippedUnitIds.includes(unitId)) {
    routing.skippedUnitIds.push(unitId);
  }
  return true;
}

function assertDirectClassBodyAllowed(ctx: CodegenContext, name: string, declaration: ts.Node): void {
  ctx.irBodyRouteAuditSession?.recordRoot("compileClassBodies", name, declaration);
  const poisoned = process.env.JS2WASM_TEST_POISON_DIRECT_CLASS_BODY;
  if (!poisoned || !poisoned.split(",").includes(name)) return;
  throw new Error(`injected direct class-body poison: ${name}`);
}

/** Compile the class bodies that were not already installed by Prepared IR. */
export function compileClassBodies(
  ctx: CodegenContext,
  decl: ts.ClassDeclaration | ts.ClassExpression,
  funcByName: Map<string, number>,
  syntheticName?: string,
  routing?: ClassBodyCompileRouting,
): void {
  routing ??= ctx.irClassBodyRouting;
  const className = syntheticName ?? decl.name?.text;
  if (!className) {
    reportError(ctx, decl, "Cannot compile unnamed class");
    return;
  }
  ctx.irBodyRouteAuditSession?.recordRoot("compileClassBodies", className, decl);
  const structTypeIdx = ctx.structMap.get(className);
  const fields = ctx.structFields.get(className);
  if (structTypeIdx === undefined || !fields) {
    reportError(ctx, decl, `Unknown class struct type: ${className}`);
    return;
  }

  // (#779a) A nested class's enclosing function can remain mid-compilation,
  // with captured-global copies in its `fctx.body`. Compiling members replaces
  // `ctx.currentFunc`, so binding-pattern string imports could otherwise shift
  // globals without that enclosing body and leave stale indices. Register it
  // on the shift-tracking stacks, mirroring object-literal methods (literals.ts).
  const enclosingFunc = ctx.currentFunc;
  if (enclosingFunc) {
    ctx.funcStack.push(enclosingFunc);
    ctx.parentBodiesStack.push(enclosingFunc.body);
  }
  try {
    compileClassBodiesInner(ctx, decl, funcByName, className, structTypeIdx, fields, routing);
  } finally {
    if (enclosingFunc) {
      ctx.funcStack.pop();
      ctx.parentBodiesStack.pop();
      ctx.currentFunc = enclosingFunc;
    }
  }
}

export function skipPreparedClassConstructorBody(
  ctx: CodegenContext,
  funcByName: ReadonlyMap<string, number>,
  routing: ClassBodyCompileRouting | undefined,
  classDeclaration: ts.ClassDeclaration | ts.ClassExpression,
  declaration: ts.ConstructorDeclaration | undefined,
  className: string,
  ctorName: string,
): boolean {
  if (!declaration) {
    const unitId = ctx.irPlanningIdentityContext?.unitIdByDeclaration.get(classDeclaration);
    if (unitId !== undefined && routing?.skipImplicitConstructorUnitIds?.has(unitId) === true) {
      const unit = ctx.irPlanningIdentityContext?.unitByUnitId.get(unitId);
      const initKey = classMemberFuncKey(ctx, `${className}_init`);
      const initLocalIdx = funcByName.get(initKey);
      const initFunc = initLocalIdx === undefined ? undefined : ctx.mod.functions[initLocalIdx];
      const newFuncIdx = ctx.funcMap.get(classMemberFuncKey(ctx, ctorName));
      const newFunc = newFuncIdx === undefined ? undefined : definedFuncAt(ctx, newFuncIdx);
      // (#3522) A top-level implicit constructor has no containing terminal; a
      // NESTED one records its enclosing executable. Membership in
      // `skipImplicitConstructorUnitIds` is already the preparer's proof that
      // the containing owner was prepared in the same transaction, so the
      // residual obligation here is that the nesting belongs to the admitted
      // bounded ordinary-class family — which excludes heritage, statics,
      // computed keys, and initialized fields, and therefore cannot reach the
      // shadow-identity inheritance surface (#4448).
      const nestedFamilyOk = unit?.terminalOwnerId === null || isBoundedPreparedNestedOrdinaryClass(classDeclaration);
      if (
        unit?.kind !== "class-implicit-constructor" ||
        !nestedFamilyOk ||
        ctx.irPlanningIdentityContext?.terminalByUnitId.has(unitId) ||
        ctx.irPlanningIdentityContext?.declarationByUnitId.get(unitId) !== classDeclaration ||
        ctx.programAbiClassCallables?.functionForUnit(unitId) !== initFunc ||
        !initFunc ||
        initFunc.body.length === 0 ||
        !newFunc ||
        newFunc.body.length === 0
      ) {
        throw new Error(`prepared implicit constructor ${ctorName} has no exact installed support pair`);
      }
      if (routing.skippedImplicitConstructorUnitIds && !routing.skippedImplicitConstructorUnitIds.includes(unitId)) {
        routing.skippedImplicitConstructorUnitIds.push(unitId);
      }
      return true;
    }
  }
  const unitId = ctx.irPlanningIdentityContext?.unitIdByDeclaration.get(declaration ?? classDeclaration);
  const exactSkip = unitId !== undefined && routing?.skipBodyUnitIds?.has(unitId) === true;
  if (!routing?.skipBodies.has(ctorName) && !exactSkip) return false;
  const newFuncIdx = ctx.funcMap.get(classMemberFuncKey(ctx, ctorName));
  const initKey = classMemberFuncKey(ctx, `${className}_init`);
  const initLocalIdx = funcByName.get(initKey);
  const initFuncIdx = ctx.funcMap.get(initKey);
  const initFunc = initLocalIdx === undefined ? undefined : ctx.mod.functions[initLocalIdx];
  const terminal = unitId ? ctx.irPlanningIdentityContext?.terminalByUnitId.get(unitId) : undefined;
  const allocated = unitId ? ctx.programAbiClassCallables?.functionForUnit(unitId) : undefined;
  if (
    unitId === undefined ||
    routing.skipBodyUnitIds?.has(unitId) !== true ||
    (terminal?.kind !== "class-constructor" && terminal?.kind !== "class-implicit-constructor") ||
    ctx.irPlanningIdentityContext?.declarationByUnitId.get(unitId) !== (declaration ?? classDeclaration) ||
    !initFunc ||
    allocated !== initFunc
  ) {
    throw new Error(`prepared constructor ${ctorName} has no exact source init owner`);
  }
  const preserveExactBody = routing.preserveSkippedBodyUnitIds?.has(unitId) === true;
  if (
    routing.skipBodies.has(ctorName) &&
    preserveExactBody !== (routing.preserveSkippedBodies?.has(ctorName) === true)
  ) {
    throw new Error(`prepared constructor ${ctorName} has inconsistent exact and legacy preserve ownership`);
  }
  if (preserveExactBody) {
    if (newFuncIdx === undefined || initFuncIdx === undefined || initFunc.body.length === 0) {
      throw new Error(`prepared constructor ${ctorName} has no installed IR init body`);
    }
    if (definedFuncAt(ctx, initFuncIdx) !== initFunc) {
      throw new Error(`prepared constructor ${ctorName} has a stale init locator`);
    }
    // Preparation installs the AST-free wrapper before component sealing.
    // The direct pass only proves the support slot survived unchanged.
    if (definedFuncAt(ctx, newFuncIdx)?.body.length === 0) {
      throw new Error(`prepared constructor ${ctorName} has no installed allocation wrapper`);
    }
  } else {
    initFunc.body = [{ op: "unreachable" }];
  }
  routing.skippedNames.push(ctorName);
  if (routing.skippedUnitIds && !routing.skippedUnitIds.includes(unitId)) {
    routing.skippedUnitIds.push(unitId);
  }
  return true;
}

function compileClassBodiesInner(
  ctx: CodegenContext,
  decl: ts.ClassDeclaration | ts.ClassExpression,
  funcByName: Map<string, number>,
  className: string,
  structTypeIdx: number,
  fields: FieldDef[],
  routing?: ClassBodyCompileRouting,
): void {
  // Compile constructor
  const ctor = findConstructorImplementation(decl);
  const ctorName = `${className}_new`;
  const isExternrefBacked = ctx.classExternrefBackedSet.has(className);
  const ctorLocalIdx = funcByName.get(classMemberFuncKey(ctx, ctorName)); // (#1983)
  if (
    ctorLocalIdx !== undefined &&
    !skipPreparedClassConstructorBody(ctx, funcByName, routing, decl, ctor, className, ctorName)
  ) {
    const func = ctx.mod.functions[ctorLocalIdx]!;
    assertDirectClassBodyAllowed(ctx, ctorName, ctor ?? decl);
    const params: { name: string; type: ValType }[] = [];
    // (#2086) Match the synthetic forwarder params added during pre-registration
    // from the SAME shared rule — `__arg{i}` externref forwarders (#1833) and/or
    // the bound ancestor-ctor params (#2082) so the replayed parent
    // `this.x = name` assignments below resolve `name`. `implicitForwarderArity`
    // / `implicitStructCtorParams` are reused later in the body-emission phase.
    const {
      implicitForwarderArity,
      implicitStructCtorParams,
      prefixParams: implicitPrefixParams,
    } = computeImplicitDerivedCtorPrefix(ctx, decl, className, ctor);
    params.push(...implicitPrefixParams);
    if (ctor) {
      for (let pi = 0; pi < ctor.parameters.length; pi++) {
        const param = ctor.parameters[pi]!;
        const paramName = ts.isIdentifier(param.name) ? param.name.text : `__param${pi}`;
        const paramType = ctx.checker.getTypeAtLocation(param);
        let wasmType = resolveWasmType(ctx, paramType);
        // Widen ref to ref_null for params with defaults or optional params
        // (caller passes ref.null as sentinel). Must match collection phase (#702)
        if ((param.initializer || param.questionToken) && wasmType.kind === "ref") {
          wasmType = { kind: "ref_null", typeIdx: (wasmType as { kind: "ref"; typeIdx: number }).typeIdx };
        }
        params.push({ name: paramName, type: wasmType });
      }
    }

    // (#1366a) Externref-backed subclasses (`class Sub extends Error`) have
    // their instance created by a host import inside `super(...)`; `__self` is
    // an externref slot and we skip the WasmGC `struct.new` initialization.
    // (#1965) WasmGC-struct classes compile the defaults + field initializers
    // + constructor BODY into `${className}_init(...params, self)`, while
    // `${className}_new` reduces to alloc + tail-call init. `super(args)`
    // calls the parent's init on the derived instance, so the parent ctor
    // body actually executes. Externref-backed classes keep the legacy
    // single-function shape (their instance comes from a host import).
    const initLocalIdx = isExternrefBacked ? undefined : funcByName.get(classMemberFuncKey(ctx, `${className}_init`)); // (#1983)
    const initFunc = initLocalIdx !== undefined ? ctx.mod.functions[initLocalIdx] : undefined;
    const splitInit = !isExternrefBacked && initFunc !== undefined;

    const fctxParams = splitInit
      ? [...params, { name: "__self", type: { kind: "ref", typeIdx: structTypeIdx } as ValType }]
      : params;
    const fctx: FunctionContext = {
      // display name only — cosmetic; the relocated funcMap/funcByName keys
      // above carry the actual identity (#1983).
      name: splitInit ? `${className}_init` : ctorName,
      params: fctxParams,
      locals: [],
      localMap: new Map(),
      returnType: isExternrefBacked ? { kind: "externref" } : { kind: "ref", typeIdx: structTypeIdx },
      body: [],
      blockDepth: 0,
      breakStack: [],
      continueStack: [],
      labelMap: new Map(),
      savedBodies: [],
      isConstructor: true,
      isDerivedConstructor: ctx.classParentMap.has(className),
    };
    fctx.activationEntryBody = fctx.body;

    // Re-resolve the constructor (and init) function types now that all class
    // struct types are registered. Constructor parameter types that reference
    // forward-declared classes may have resolved to externref during the
    // collection phase.
    {
      const resolvedParams = params.map((p) => p.type);
      const resolvedResults: ValType[] = isExternrefBacked
        ? [{ kind: "externref" }]
        : [{ kind: "ref", typeIdx: structTypeIdx }];
      const updatedTypeIdx = addFuncType(ctx, resolvedParams, resolvedResults, `${ctorName}_type`);
      if (updatedTypeIdx !== func.typeIdx) {
        func.typeIdx = updatedTypeIdx;
      }
      if (splitInit && initFunc) {
        const initResolvedParams = fctxParams.map((p) => p.type);
        const updatedInitTypeIdx = addFuncType(ctx, initResolvedParams, resolvedResults, `${className}_init_type`);
        if (updatedInitTypeIdx !== initFunc.typeIdx) {
          initFunc.typeIdx = updatedInitTypeIdx;
        }
      }
    }

    for (let i = 0; i < fctxParams.length; i++) {
      fctx.localMap.set(fctxParams[i]!.name, i);
    }

    // The struct instance binding: a param of `_init` for split classes, a
    // local for externref-backed ones.
    const selfLocal = splitInit
      ? fctxParams.length - 1
      : allocLocal(fctx, "__self", isExternrefBacked ? { kind: "externref" } : { kind: "ref", typeIdx: structTypeIdx });

    if (isExternrefBacked) {
      // No struct.new; `__self` starts as null externref and is set by the
      // explicit `super(...)` call (compileSuperCall) or by the implicit
      // super-call we emit below for default-constructor subclasses.
      fctx.body.push({ op: "ref.null.extern" });
      fctx.body.push({ op: "local.set", index: selfLocal });
    } else if (!splitInit) {
      // Legacy fallback (no `${className}_init` registered): allocate inline.
      // Push default values for all fields, then struct.new
      for (const field of fields) {
        if (field.name === "__tag") {
          // Push the class-specific tag value for instanceof discrimination
          const tagValue = ctx.classTagMap.get(className) ?? 0;
          fctx.body.push({ op: "i32.const", value: tagValue });
        } else if (field.type.kind === "f64") {
          fctx.body.push({ op: "f64.const", value: 0 });
        } else if (field.type.kind === "i32") {
          fctx.body.push({ op: "i32.const", value: 0 });
        } else if (field.type.kind === "externref") {
          fctx.body.push({ op: "ref.null.extern" });
        } else if (field.type.kind === "ref" || field.type.kind === "ref_null") {
          fctx.body.push({ op: "ref.null", typeIdx: field.type.typeIdx });
        } else if ((field.type as any).kind === "i64") {
          fctx.body.push({ op: "i64.const", value: 0n });
        } else if ((field.type as any).kind === "eqref") {
          fctx.body.push({ op: "ref.null.eq" });
        } else {
          // Fallback for any unhandled type — push i32 0
          fctx.body.push({ op: "i32.const", value: 0 });
        }
      }
      fctx.body.push({ op: "struct.new", typeIdx: structTypeIdx });
      fctx.body.push({ op: "local.set", index: selfLocal });
    }
    // splitInit: `self` arrives as the last param — allocation happens in
    // `${className}_new`, emitted at the end of this function.

    // (#802) `$__proto__` initialization: nothing to do here — the appended
    // dynamic-proto field (marked hierarchy roots only, see the field build
    // above) is covered by the iterate-and-default alloc loops, which emit
    // `ref.null.extern` for it. Null = "never dynamically set".

    // Compile constructor body — `this` maps to __self local
    fctx.localMap.set("this", selfLocal);
    ctx.currentFunc = fctx;

    // (#1965) Does this implicit ctor forward to a real parent `_init`?
    // If so, the parent's init applies the forwarded params' defaults — this
    // function must NOT apply them too (a default expression with side
    // effects would run twice, and the raw args + untouched `__argc` global
    // flow through to the parent's own check).
    const implicitParentInitIdx =
      splitInit && !ctor
        ? ctx.funcMap.get(classMemberFuncKey(ctx, `${ctx.classParentMap.get(className) ?? ""}_init`)) // (#1983)
        : undefined;

    // Emit default-value initialization for constructor parameters with initializers.
    // For primitive params, __argc distinguishes an omitted argument from a
    // legitimate falsy value. Ref/externref params keep their value checks.
    // #2082: the implicit ctor must also honour the FORWARDED parent params'
    // defaults (`class A { constructor(v = 7){...} }; class B extends A {}` →
    // `new B()` must see v = 7). Those params occupy indices
    // [implicitForwarderArity, implicitForwarderArity + len) — 0-based here
    // since a WasmGC-struct implicit ctor has no externref forwarder prefix.
    // (#1965) ...unless the forwarded params flow into a real parent `_init`
    // call, which applies its own defaults.
    const defaultInitParams: ts.NodeArray<ts.ParameterDeclaration> | undefined =
      ctor?.parameters ?? (implicitParentInitIdx !== undefined ? undefined : implicitStructCtorParams);
    const defaultInitBase = ctor ? 0 : implicitForwarderArity;
    if (defaultInitParams) {
      const defaultArgcLocal = defaultInitParams.some((param, i) => {
        if (!param.initializer) return false;
        return paramDefaultNeedsArgc(params[defaultInitBase + i]?.type);
      })
        ? cacheParamDefaultArgc(ctx, fctx)
        : undefined;
      for (let i = 0; i < defaultInitParams.length; i++) {
        const param = defaultInitParams[i]!;
        if (!param.initializer) continue;

        const paramIdx = defaultInitBase + i;
        const paramType = params[paramIdx]!.type;

        // Pre-ensure `__extern_is_undefined` before compiling the initializer so
        // any late-import funcIdx shift happens while `fctx.body` is authoritative.
        // Without this, the initializer compiles into `thenInstrs`, which gets
        // detached from `fctx` after popBody below — any subsequent shift
        // triggered by ensureLateImport in the check emission would miss
        // `thenInstrs`, leaving stale funcIdx values in its `call` ops.
        if (paramType.kind === "externref") {
          ensureLateImport(ctx, "__extern_is_undefined", [{ kind: "externref" }], [{ kind: "i32" }]);
          flushLateImportShifts(ctx, fctx);
        }

        // Build the "then" block: compile default expression, local.set
        const savedBody = pushBody(fctx);
        // (#1451) For array binding patterns with externref param, force the
        // default's array literals to compile as vec (not tuple) — same
        // rationale as the method site below. See function-body.ts:701.
        const ctorIsArrayPatternExternref = ts.isArrayBindingPattern(param.name) && paramType.kind === "externref";
        const ctorPrevForceVec = (ctx as unknown as { _arrayLiteralForceVec?: boolean })._arrayLiteralForceVec;
        if (ctorIsArrayPatternExternref) {
          (ctx as unknown as { _arrayLiteralForceVec?: boolean })._arrayLiteralForceVec = true;
        }
        let ctorDfltType: ValType | null;
        try {
          ctorDfltType = compileExpression(ctx, fctx, param.initializer, paramType);
        } finally {
          if (ctorIsArrayPatternExternref) {
            (ctx as unknown as { _arrayLiteralForceVec?: boolean })._arrayLiteralForceVec = ctorPrevForceVec;
          }
        }
        if (ctorDfltType && !valTypesMatch(ctorDfltType, paramType)) {
          coerceType(ctx, fctx, ctorDfltType, paramType);
        }
        fctx.body.push({ op: "local.set", index: paramIdx });
        const thenInstrs = fctx.body;
        popBody(fctx, savedBody);

        emitClassParamDefaultCheck(ctx, fctx, paramIdx, paramType, thenInstrs, i, defaultArgcLocal);
      }
    }

    // (#1366a / #1833) For externref-backed subclasses, the parent-chain
    // field-walk path is irrelevant (no struct fields to copy). When there's no
    // explicit ctor, emit the default derived constructor: forward the synthetic
    // externref parameter list to `__new_<ParentBuiltin>(...)`.
    if (!ctor && isExternrefBacked) {
      const parentName = ctx.classBuiltinParentMap.get(className);
      if (parentName) {
        const importName = getParentConstructorImportName(ctx, parentName);
        const forwardParams = externrefParams(implicitForwarderArity);
        // Standalone / WASI: route the parent instance creation through the
        // shared native-`__new_<Parent>` dispatch ladder
        // (`resolveStandaloneBuiltinSuperCtorIdx` — #1536c Error family, #3238
        // Object, #2917 Array, #3239 vec builtins; per-arity helpers, DEFINED
        // funcs, no index shift). JS-host mode / parents with no native ctor
        // yet keep the host import.
        let funcIdx: number | undefined;
        const nativeCtorIdx = resolveStandaloneBuiltinSuperCtorIdx(ctx, parentName, implicitForwarderArity);
        if (nativeCtorIdx !== undefined) {
          funcIdx = nativeCtorIdx ?? undefined;
        } else {
          funcIdx = ensureLateImport(ctx, importName, forwardParams, [{ kind: "externref" }]);
          flushLateImportShifts(ctx, fctx);
        }
        if (funcIdx !== undefined) {
          for (let i = 0; i < implicitForwarderArity; i++) {
            fctx.body.push({ op: "local.get", index: i });
          }
          fctx.body.push({ op: "call", funcIdx });
        } else {
          // Standalone (no host import): treat the first constructor argument
          // as the instance, matching the previous single-arg fallback.
          if (implicitForwarderArity > 0) {
            fctx.body.push({ op: "local.get", index: 0 });
          } else {
            fctx.body.push({ op: "ref.null.extern" });
          }
        }
        fctx.body.push({ op: "local.set", index: selfLocal });
        // (#1455) Set the instance's [[Prototype]] to `Sub.prototype` so
        // `instance instanceof Sub` walks through it, in addition to
        // `instance instanceof Parent` (already true via Parent.prototype).
        emitSetSubclassProto(ctx, fctx, selfLocal, className, parentName);
        // (#2188) Brand the standalone instance with this subclass's tag so
        // sibling `extends Error` subclasses are distinguishable by instanceof.
        emitSetSubclassUserBrand(ctx, fctx, selfLocal, className);
      }
    }

    // When a child class has no explicit constructor, the spec synthesizes
    // `constructor(...args) { super(...args); }`. (#1965) With the init
    // split this is a REAL call to the parent's `_init` on this instance —
    // the parent runs its own field initializers and full ctor body (which
    // recursively chains to ITS parent). The old AST replay (field
    // initializers + mined `this.x = ...` assignments) is gone: it skipped
    // every non-assignment statement of the ancestor ctor bodies.
    if (!ctor && !isExternrefBacked) {
      if (implicitParentInitIdx !== undefined) {
        // Forward our params 1:1 (they were cloned from the nearest explicit
        // ancestor ctor's param list — #2082), then self. `__argc` from the
        // `new` call site flows through untouched so the parent's defaults
        // fire exactly as if it had been constructed directly.
        for (let i = 0; i < params.length; i++) {
          fctx.body.push({ op: "local.get", index: i });
        }
        fctx.body.push({ op: "local.get", index: selfLocal });
        fctx.body.push({ op: "call", funcIdx: implicitParentInitIdx });
        fctx.body.push({ op: "drop" });
      } else if (ctx.classParentMap.get(className) !== undefined) {
        // Legacy fallback (parent has no `_init` — should not happen for
        // user struct classes): keep prior behavior of replaying ancestor
        // field initializers so fields are not silently zero.
        const parentClassName = ctx.classParentMap.get(className)!;
        const ancestors: string[] = [];
        const visitedAnc = new Set<string>();
        let anc: string | undefined = parentClassName;
        while (anc && !visitedAnc.has(anc)) {
          visitedAnc.add(anc);
          ancestors.unshift(anc);
          anc = ctx.classParentMap.get(anc);
        }
        for (const ancName of ancestors) {
          const ancDecl = ctx.classDeclarationMap.get(ancName);
          if (!ancDecl) continue;
          for (const member of ancDecl.members) {
            if (ts.isPropertyDeclaration(member) && member.name && member.initializer && !hasStaticModifier(member)) {
              const fieldName = resolveClassMemberName(ctx, member.name);
              if (fieldName === undefined) continue;
              const fieldIdx = fields.findIndex((f) => f.name === fieldName);
              if (fieldIdx !== -1) {
                fctx.body.push({ op: "local.get", index: selfLocal });
                compileExpression(ctx, fctx, member.initializer, fields[fieldIdx]!.type);
                fctx.body.push({ op: "struct.set", typeIdx: structTypeIdx, fieldIdx });
              }
            }
          }
        }
      }
    }

    const isDerivedClass = ctx.classParentMap.has(className) || ctx.classBuiltinParentMap.has(className);
    let ownFieldInitializersEmitted = false;
    const emitOwnInstanceFieldInitializers = (): void => {
      // Compile field initializers from property declarations
      // (e.g., x: number = 42, #x: number = 42). (#1366a) Skip for
      // externref-backed classes — they have no WasmGC struct fields; user
      // `prop = ...` declarations inside `class Sub extends Error` would need
      // to be installed via host setters, which is out of scope.
      if (isExternrefBacked || ownFieldInitializersEmitted) return;
      ownFieldInitializersEmitted = true;
      for (const member of decl.members) {
        if (ts.isPropertyDeclaration(member) && member.name && member.initializer && !hasStaticModifier(member)) {
          const fieldName = resolveClassMemberName(ctx, member.name);
          if (fieldName === undefined) continue; // dynamic computed name — skip
          const fieldIdx = fields.findIndex((f) => f.name === fieldName);
          if (fieldIdx !== -1) {
            fctx.body.push({ op: "local.get", index: selfLocal });
            compileExpression(ctx, fctx, member.initializer, fields[fieldIdx]!.type);
            fctx.body.push({ op: "struct.set", typeIdx: structTypeIdx, fieldIdx });
          }
        }
      }
    };

    // Base classes and implicit derived constructors run own fields at the
    // original constructor-initialization point. Explicit derived constructors
    // must wait until `super()` returns (§13.3.7.1).
    if (!isDerivedClass || !ctor) {
      emitOwnInstanceFieldInitializers();
    }

    // (#846h) A derived class with an explicit constructor that never calls
    // `super(...)` never initialises `this`. Per ES §10.2.2 [[Construct]] and
    // §13.3.7.1 SuperCall, accessing `this` or returning from such a
    // constructor must throw a ReferenceError. We detect the statically-provable
    // case (no lexical `super()` anywhere in the constructor body) and emit an
    // unconditional throw at the constructor entry, skipping the (now dead)
    // body compilation.
    const ctorMissingSuper = isDerivedClass && ctor?.body !== undefined && !constructorBodyHasSuperCall(ctor.body);

    if (ctorMissingSuper) {
      // A derived constructor that returns a primitive before calling
      // `super()` still reaches [[Construct]]'s return-value check.  The
      // missing-`super` ReferenceError is correct when the body falls through
      // (or returns undefined), but a primitive return is the specified
      // TypeError instead.  Keep this deliberately narrow: a single return
      // statement with a checker-proven primitive can be diagnosed without
      // replaying the whole constructor body, while all other missing-super
      // bodies retain the established ReferenceError path. (#4450)
      const onlyStatement = ctor?.body?.statements.length === 1 ? ctor.body.statements[0] : undefined;
      if (
        onlyStatement &&
        ts.isReturnStatement(onlyStatement) &&
        onlyStatement.expression &&
        (ctx.checker.getTypeAtLocation(onlyStatement.expression).flags &
          (ts.TypeFlags.NumberLike |
            ts.TypeFlags.BooleanLike |
            ts.TypeFlags.BigIntLike |
            ts.TypeFlags.StringLike |
            ts.TypeFlags.ESSymbolLike)) !==
          0
      ) {
        emitThrowTypeError(ctx, fctx, "Derived constructors may only return an object or undefined");
      } else {
        // (#1682) Throw a real ReferenceError instance (not a bare string) so
        // `e instanceof ReferenceError` holds for the caller. emitThrowReferenceError
        // constructs via __new_ReferenceError and degrades to a string throw only
        // when the constructor import is unavailable.
        emitThrowReferenceError(
          ctx,
          fctx,
          "Must call super constructor in derived class before accessing 'this' or returning from derived constructor",
        );
      }
    } else if (ctor?.body) {
      // (#2641) Hoist var + let/const declarations BEFORE the body loop, just
      // like free functions (function-body.ts). Without this, a constructor-local
      // `let`/`const` that shadows a same-named module variable never gets a Wasm
      // local and falls through to the module global (invalid Wasm with native
      // strings, silent miscompilation otherwise). Hoisting BEFORE the loop leaves
      // the super-call inlining below undisturbed. The #1210 string-builder
      // detector runs first so the hoist skips builder bindings (parity gate).
      if (ctx.nativeStrings && ctx.anyStrTypeIdx >= 0) {
        const presize = new Map<ts.VariableDeclaration, StringBuilderPresizeInfo>();
        const builders = detectStringBuilders(ctx, ctor.body, presize);
        if (builders.size > 0) fctx.pendingStringBuilders = builders;
        if (presize.size > 0) fctx.stringBuilderPresize = presize;
      }
      hoistVarDeclarations(ctx, fctx, ctor.body.statements);
      hoistLetConstWithTdz(ctx, fctx, ctor.body.statements);
      for (const stmt of ctor.body.statements) {
        // Handle super(args) calls: inline parent constructor field initialization
        if (
          ts.isExpressionStatement(stmt) &&
          ts.isCallExpression(stmt.expression) &&
          stmt.expression.expression.kind === ts.SyntaxKind.SuperKeyword
        ) {
          compileSuperCall(ctx, fctx, className, selfLocal, stmt.expression, fields);
          if (isDerivedClass) {
            emitOwnInstanceFieldInitializers();
          }
          continue;
        }
        compileStatement(ctx, fctx, stmt);
      }
    }

    // (#1455) Tag externref-backed user-class instances with their class name
    // so the modified `__instanceof` host import can resolve
    // `instance instanceof Sub` by walking the registered tag chain. The
    // direct user-class parent (or null when the direct parent is a builtin)
    // is registered idempotently on first call.
    // (#1536c) Skipped under standalone / WASI: `__tag_user_class` is a JS host
    // import (it would leak `env::__tag_user_class` and fail to instantiate).
    // Standalone resolves `instance instanceof Sub`/`Parent` natively via the
    // `$Error_struct` `$tag` discrimination (identifiers.ts) — no host tagging
    // needed.
    if (isExternrefBacked && !(ctx.wasi || ctx.standalone)) {
      const builtinParent = ctx.classBuiltinParentMap.get(className);
      // Direct user-class parent: classParentMap[className] is set to the
      // immediate parent name; if it equals the builtin parent, the user
      // chain terminates here (pass ref.null.extern for the parent arg).
      const directParent = ctx.classParentMap.get(className);
      const userParent = directParent && directParent !== builtinParent ? directParent : undefined;
      const tagIdx = ensureLateImport(
        ctx,
        "__tag_user_class",
        [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
        [],
      );
      flushLateImportShifts(ctx, fctx);
      if (tagIdx !== undefined) {
        fctx.body.push({ op: "local.get", index: selfLocal });
        // Class name as string constant externref
        addStringConstantGlobal(ctx, className);
        const cnameIdx = ctx.stringGlobalMap.get(className);
        if (cnameIdx !== undefined && cnameIdx !== -1) {
          fctx.body.push({ op: "global.get", index: cnameIdx });
        } else {
          fctx.body.push({ op: "ref.null.extern" });
        }
        // Parent name (or null externref).
        if (userParent !== undefined) {
          addStringConstantGlobal(ctx, userParent);
          const pnameIdx = ctx.stringGlobalMap.get(userParent);
          if (pnameIdx !== undefined && pnameIdx !== -1) {
            fctx.body.push({ op: "global.get", index: pnameIdx });
          } else {
            fctx.body.push({ op: "ref.null.extern" });
          }
        } else {
          fctx.body.push({ op: "ref.null.extern" });
        }
        fctx.body.push({ op: "call", funcIdx: tagIdx });
      }
    }

    // (#3123) `class C extends F` where F is a top-level PLAIN FUNCTION
    // (fnctor): register the instance with the host runtime so member reads
    // that MISS the compiled surface resolve through F's LIVE `.prototype`
    // chain (`_fnctorInstanceCtor` → `_fnctorProtoLookup`). The test262
    // harness `Iterator` shim assigns `F.prototype` at module init; the
    // Iterator-helper methods the instance inherits live only on that runtime
    // object. Host lane only — standalone/wasi have no host MOP (the import
    // would leak). Runs at the tail of the ctor body (the `_init` body for
    // split classes), so every construction path — `new C()` and `super()`
    // from a subclass — registers (WeakMap set, idempotent).
    if (!isExternrefBacked && !(ctx.wasi || ctx.standalone)) {
      const fnctorParent = fnctorAncestorOfClass(ctx, className);
      if (fnctorParent !== undefined) {
        const regIdx = ensureLateImport(
          ctx,
          "__register_fnctor_instance",
          [{ kind: "externref" }, { kind: "externref" }],
          [],
        );
        flushLateImportShifts(ctx, fctx);
        // Read F's funcIdx AFTER the late-import flush — the import add above
        // shifts every defined-func index.
        const fnctorFuncIdx = ctx.funcMap.get(fnctorParent);
        if (regIdx !== undefined && fnctorFuncIdx !== undefined) {
          fctx.body.push({ op: "local.get", index: selfLocal });
          fctx.body.push({ op: "extern.convert_any" });
          // F's canonical cached closure — identity-stable with the receiver
          // the top-level `F.prototype = …` write resolved to, so the host
          // lookup reads the SAME sidecar/field slot.
          const closTy = emitCachedFuncClosureAccess(ctx, fctx, fnctorParent, fnctorFuncIdx);
          if (closTy !== null) {
            fctx.body.push({ op: "extern.convert_any" });
            const finalRegIdx = ctx.funcMap.get("__register_fnctor_instance") ?? regIdx;
            fctx.body.push({ op: "call", funcIdx: finalRegIdx });
          } else {
            // Closure signature unresolvable — drop the self externref, skip.
            fctx.body.push({ op: "drop" });
          }
        }
      }
    }

    // Return the struct instance
    fctx.body.push({ op: "local.get", index: selfLocal });

    cacheStringLiterals(ctx, fctx);
    deduplicateLocals(fctx);
    if (splitInit && initFunc) {
      // (#1965) The body compiled above IS `${className}_init`. Fill
      // `${className}_new` with: alloc (defaults + tag) → tail-call init.
      initFunc.locals = fctx.locals;
      initFunc.body = fctx.body;

      const initIdxNow = ctx.funcMap.get(classMemberFuncKey(ctx, `${className}_init`)); // (#1983)
      const newIdxNow = ctx.funcMap.get(classMemberFuncKey(ctx, ctorName));
      installAstFreeClassConstructorNewWrapper(ctx, {
        className,
        structTypeIdx,
        fields,
        newFuncIdx: newIdxNow!,
        initFuncIdx: initIdxNow!,
      });
    } else {
      func.locals = fctx.locals;
      func.body = fctx.body;
    }
    ctx.currentFunc = null;
  }

  // (#2637 B2.3) For a `class … extends Promise` with a user ctor, also fill
  // the run-on-host-`this` body `${className}_new__onhost` (pre-registered in
  // collectClassDeclaration). It mirrors the direct-new ctor body but binds
  // `this`/`$__self` to V8's NewPromiseCapability promise (`__current_this`)
  // instead of allocating its own — see the function for the correctness trap.
  if (isPromiseSubclassWithUserCtor(ctx, className, ctor)) {
    emitPromiseSubclassOnHostCtor(ctx, decl, funcByName, className, ctor!);
  }

  // Compile methods (instance and static)
  // Track which methods have been compiled to avoid overwriting when
  // both static and instance methods share the same name.
  const compiledMethods = new Set<string>();
  for (const member of decl.members) {
    if (ts.isMethodDeclaration(member) && member.name && member.body) {
      if (skipExactPreparedClassBody(ctx, member, routing)) continue;
      const methodName = resolveClassMemberName(ctx, member.name);
      if (methodName === undefined) continue; // dynamic computed name — skip
      const fullName = `${className}_${methodName}`;
      const isStatic = hasStaticModifier(member);
      const memberKind = isStatic ? "static" : "instance";
      const compileKey = `${fullName}:${memberKind}`;
      if (compiledMethods.has(compileKey)) continue; // already compiled
      compiledMethods.add(compileKey);
      const methodLocalIdx = funcByName.get(classMemberFuncKey(ctx, fullName, memberKind)); // (#1983)
      if (methodLocalIdx === undefined) continue;

      const func = ctx.mod.functions[methodLocalIdx]!;
      // (#3522) Methods whose complete ABI component was sealed and
      // installed before direct emission own this exact slot. A prepared body
      // stays intact; an invariant-owned failure receives only a non-shipping
      // placeholder. Exact source constructors use the corresponding skip
      // seam above; their allocation wrappers remain AST-free support.
      if (routing?.skipBodies.has(fullName)) {
        if (!routing.preserveSkippedBodies?.has(fullName)) {
          func.body = [{ op: "unreachable" }];
        }
        routing.skippedNames.push(fullName);
        continue;
      }
      assertDirectClassBodyAllowed(ctx, fullName, member);
      const sig = ctx.checker.getSignatureFromDeclaration(member);
      const retType = sig ? ctx.checker.getReturnTypeOfSignature(sig) : undefined;

      // Static methods have no self param; instance methods get self as first
      // param. Host-backed subclasses (including Node extern classes such as
      // EventEmitter) carry a real JS object, not a WasmGC `$Class` value, so
      // their method ABI must use externref for the receiver. Keeping the old
      // ref-typed receiver here made the body impossible to call after
      // `super()` returned the host object (#4534).
      const params: { name: string; type: ValType }[] = isStatic
        ? []
        : [
            {
              name: "this",
              type: isExternrefBacked ? { kind: "externref" } : { kind: "ref", typeIdx: structTypeIdx },
            },
          ];
      for (let pi = 0; pi < member.parameters.length; pi++) {
        const param = member.parameters[pi]!;
        const paramName = ts.isIdentifier(param.name) ? param.name.text : `__param${pi}`;
        const paramType = ctx.checker.getTypeAtLocation(param);
        // Unannotated binding-pattern method params route through the
        // externref destructure path so the iterator protocol drives element
        // extraction — same rule as function declarations (#862) and arrows
        // (closures.ts:905). NOTE: explicitly scoped to methods only; the
        // constructor path (class-bodies.ts:680-696) is left unchanged.
        const bindingPatternNeedsWiden =
          !param.type &&
          !param.dotDotDotToken &&
          (ts.isArrayBindingPattern(param.name) || ts.isObjectBindingPattern(param.name));
        let wasmType: ValType;
        if (param.dotDotDotToken) {
          const typeArgs = ctx.checker.getTypeArguments(paramType as ts.TypeReference);
          const elemTsType = typeArgs[0];
          const elemType: ValType = elemTsType ? resolveWasmType(ctx, elemTsType) : { kind: "f64" };
          const elemKey =
            elemType.kind === "ref" || elemType.kind === "ref_null"
              ? `ref_${(elemType as { typeIdx: number }).typeIdx}`
              : elemType.kind;
          const vecTypeIdx = getOrRegisterVecType(ctx, elemKey, elemType);
          wasmType = { kind: "ref_null", typeIdx: vecTypeIdx };
        } else {
          wasmType = bindingPatternNeedsWiden ? ({ kind: "externref" } as ValType) : resolveWasmType(ctx, paramType);
        }
        // Widen ref to ref_null for params with defaults or optional params
        // (caller passes ref.null as sentinel). Must match collection phase (#702)
        if ((param.initializer || param.questionToken) && wasmType.kind === "ref") {
          wasmType = { kind: "ref_null", typeIdx: (wasmType as { kind: "ref"; typeIdx: number }).typeIdx };
        }
        params.push({ name: paramName, type: wasmType });
      }

      const isGeneratorMethod = member.asteriskToken !== undefined;
      const isAsyncMethod = member.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ?? false;

      // (#2571) A native-lowered generator method returns its `$GenState_*`
      // struct ref (registered in the collection pass under the same
      // classMemberFuncKey); its fctx returnType must match that wasm result
      // type, not the eager-buffer `externref`. JS-host (no native registration)
      // keeps `externref`.
      const nativeGenInfo = isGeneratorMethod
        ? ctx.nativeGenerators.get(classMemberFuncKey(ctx, fullName, memberKind))
        : undefined;
      const genMethodReturnType: ValType = nativeGenInfo
        ? { kind: "ref", typeIdx: nativeGenInfo.stateTypeIdx }
        : { kind: "externref" };

      const fctx: FunctionContext = {
        name: fullName,
        params,
        locals: [],
        localMap: new Map(),
        returnType: isGeneratorMethod
          ? genMethodReturnType
          : retType && !isVoidType(retType)
            ? resolveWasmType(ctx, retType)
            : null,
        body: [],
        blockDepth: 0,
        breakStack: [],
        continueStack: [],
        labelMap: new Map(),
        savedBodies: [],
        isGenerator: isGeneratorMethod,
        enclosingClassName: className,
        // (#1395) Static methods: `this` resolves to the class constructor
        // object (the `__class_<Name>` singleton). Without `isStaticContext`,
        // bare `this` inside a static method would fall through to
        // `emitUndefined` because static methods have no `this` param.
        isStaticContext: isStatic ? true : undefined,
      };
      fctx.activationEntryBody = fctx.body;

      // Re-resolve the function type now that all class struct types are registered.
      // During the collection phase, forward-referenced class types (e.g., a method
      // returning a class declared later in the source) resolve to externref because
      // the target struct type doesn't exist yet. By this point all struct types are
      // registered, so re-resolving produces the correct ref types.
      {
        const resolvedParams = params.map((p) => p.type);
        const resolvedResults: ValType[] = fctx.returnType ? [fctx.returnType] : [];
        const updatedTypeIdx = addFuncType(ctx, resolvedParams, resolvedResults, `${fullName}_type`);
        if (updatedTypeIdx !== func.typeIdx) {
          func.typeIdx = updatedTypeIdx;
        }
      }

      for (let i = 0; i < params.length; i++) {
        fctx.localMap.set(params[i]!.name, i);
      }

      ctx.currentFunc = fctx;

      // Emit default-value initialization for method parameters with initializers.
      const defaultArgcLocal = member.parameters.some((param, i) => {
        if (!param.initializer) return false;
        const paramLocalIdx = isStatic ? i : i + 1;
        return paramDefaultNeedsArgc(params[paramLocalIdx]?.type);
      })
        ? cacheParamDefaultArgc(ctx, fctx)
        : undefined;
      for (let pi = 0; pi < member.parameters.length; pi++) {
        const param = member.parameters[pi]!;
        if (!param.initializer) continue;

        const paramLocalIdx = isStatic ? pi : pi + 1; // account for 'this' param
        const paramType = params[paramLocalIdx]!.type;

        // Pre-ensure `__extern_is_undefined` before compiling the initializer so
        // any late-import shift happens while `fctx.body` is authoritative. See
        // constructor site above for the full rationale.
        if (paramType.kind === "externref") {
          ensureLateImport(ctx, "__extern_is_undefined", [{ kind: "externref" }], [{ kind: "i32" }]);
          flushLateImportShifts(ctx, fctx);
        }

        // Per spec §14.3.3.1/§8.4.2: throw TypeError when destructuring null/undefined.
        // Literal null/undefined default on a binding pattern means: when default fires,
        // destructuring that value must throw.
        const dstrNullDefault =
          (ts.isObjectBindingPattern(param.name) || ts.isArrayBindingPattern(param.name)) &&
          isNullOrUndefinedLiteral(param.initializer);

        // Build the "then" block: compile default expression, local.set
        const savedBody = pushBody(fctx);
        if (dstrNullDefault) {
          for (const ins of buildDestructureNullThrow(ctx, fctx)) fctx.body.push(ins);
        } else {
          // (#1451) For array binding patterns with externref param, force the
          // default's array literals to compile as vec (not tuple) so the
          // destructure path can iterate them via __array_from_iter. Without
          // this, `method([_a, _b, ...x] = [1, 2])` produces a tuple struct
          // for the default, and the rest-element handler's array.copy traps
          // when it casts the tuple to an array. Mirrors function-body.ts:701
          // (function-decl) and closures.ts:935 (object-literal methods).
          const isArrayPatternExternref = ts.isArrayBindingPattern(param.name) && paramType.kind === "externref";
          const prevForceVec = (ctx as unknown as { _arrayLiteralForceVec?: boolean })._arrayLiteralForceVec;
          if (isArrayPatternExternref) {
            (ctx as unknown as { _arrayLiteralForceVec?: boolean })._arrayLiteralForceVec = true;
          }
          // (#2568) For an OBJECT binding pattern whose param lowers to externref
          // (standalone / dynamic object), compile the default object literal
          // against the binding pattern's STRUCT type rather than externref.
          // Hinting externref boxes each nested field to externref, producing a
          // struct shape (`{ w: externref }`) that does NOT match the shape the
          // destructuring `ref.test`/`ref.cast` derives from the pattern's TS type
          // (`{ w: (ref null $inner) }`). The mismatch makes the fast struct path's
          // `ref.test` fail, dropping to the __extern_get else-branch which can't
          // read the boxed nested fields → the bindings read 0. Materializing the
          // default as the pattern's struct (then `extern.convert_any` to the
          // externref param local, which preserves struct identity) makes the
          // later `ref.test` succeed — exactly the shape the call-site (provided
          // value) path already builds. Host mode is uniform-JS-object and uses
          // the externref hint unchanged.
          const objectPatternStructHint =
            ts.isObjectBindingPattern(param.name) && paramType.kind === "externref"
              ? structHintForBindingPattern(ctx, param.name)
              : undefined;
          let methDfltType: ValType | null;
          try {
            methDfltType = compileExpression(ctx, fctx, param.initializer, objectPatternStructHint ?? paramType);
          } finally {
            if (isArrayPatternExternref) {
              (ctx as unknown as { _arrayLiteralForceVec?: boolean })._arrayLiteralForceVec = prevForceVec;
            }
          }
          // Coerce the materialized value to the param's wasm type (externref).
          // When we hinted a struct, this is the struct→externref `extern.convert_any`
          // that boxes the struct ref into the externref param while preserving its
          // concrete struct identity for the downstream `ref.test`.
          if (methDfltType && !valTypesMatch(methDfltType, paramType)) {
            coerceType(ctx, fctx, methDfltType, paramType);
          }
          fctx.body.push({ op: "local.set", index: paramLocalIdx });
        }
        const thenInstrs = fctx.body;
        popBody(fctx, savedBody);

        emitClassParamDefaultCheck(ctx, fctx, paramLocalIdx, paramType, thenInstrs, pi, defaultArgcLocal);
      }

      // Destructure parameters with binding patterns
      for (let pi = 0; pi < member.parameters.length; pi++) {
        const param = member.parameters[pi]!;
        const paramLocalIdx = isStatic ? pi : pi + 1; // account for 'this' param
        if (ts.isObjectBindingPattern(param.name)) {
          destructureParamObject(ctx, fctx, paramLocalIdx, param.name, params[paramLocalIdx]!.type);
        } else if (ts.isArrayBindingPattern(param.name)) {
          destructureParamArray(ctx, fctx, paramLocalIdx, param.name, params[paramLocalIdx]!.type);
        }
      }

      // Set up `arguments` object if the method body references it (#820).
      // Class methods (like standalone functions) need an arguments vec struct
      // so that `arguments.length` and `arguments[n]` work at runtime.
      if (needsImplicitArgumentsObject(member)) {
        const methodParamTypes = params.slice(isStatic ? 0 : 1).map((p) => p.type);
        const paramOffset = isStatic ? 0 : 1; // skip 'this' param for instance methods
        // Class bodies are always strict code → unmapped arguments (#779e).
        emitArgumentsObject(ctx, fctx, methodParamTypes, paramOffset, true);
      }

      if (isGeneratorMethod && member.body && nativeGenInfo) {
        // (#2571) Native lazy generator method: emit the state-struct factory
        // (pushes the `$GenState_*` ref) instead of the eager host buffer. The
        // resume function + `.next()/.return()/.throw()` dispatch are already
        // representation-agnostic. No host imports, instantiates standalone.
        compileNativeGeneratorFunction(ctx, fctx, member, nativeGenInfo);
        fctx.body.push({ op: "return" });
      } else if (
        isGeneratorMethod &&
        isAsyncMethod &&
        member.body &&
        // (#3132 S2a/S2) Bounded async-generator METHOD drive — same
        // interception as function-body.ts (declarations) / closures.ts
        // (expressions). S2 receiver threading: an INSTANCE method body that
        // reads `this` is drivable — the receiver is the synthetic param 0
        // (`this`, typed `ref $Class`), captured into the frame as a param
        // field and restored BY NAME into the resume fn's localMap
        // (ensureAsyncResumeFunction's param-restore loop), so the ThisKeyword
        // branch in expressions.ts resolves it exactly as in the entry body.
        // Still legacy (correct-or-legacy): `super` (needs a home-object
        // binding the resume fn does not carry), `arguments` (vec struct is
        // entry-fn state), and a STATIC body reading `this` (static `this`
        // resolves via the `fctx.isStaticContext`/`enclosingClassName` class-
        // object-global fallback, which the resume FunctionContext does not
        // thread). The drive gate (`isAsyncGenDriveCandidate`) self-limits to
        // the standalone/wasi lanes and enforces the bounded body +
        // stem-collision rules.
        !genBodyReferencesSuper(member.body) &&
        !(isStatic && genBodyReferencesThis(member.body)) &&
        !bodyNeedsArgumentsObject(member.body) &&
        isAsyncGenDriveCandidate(ctx, member)
      ) {
        emitAsyncGenerator(ctx, fctx, member);
        fctx.body.push({ op: "return" });
      } else if (isGeneratorMethod && member.body) {
        // Generator method: eagerly evaluate body, collect yields into a buffer,
        // then wrap with __create_generator to return a Generator-like object.
        // Body is wrapped in try/catch to defer thrown exceptions to first next() (#928).
        const bufferLocal = allocLocal(fctx, "__gen_buffer", { kind: "externref" });
        const pendingThrowLocal = allocLocal(fctx, "__gen_pending_throw", { kind: "externref" });
        const createBufIdx = ctx.funcMap.get("__gen_create_buffer")!;
        fctx.body.push({ op: "call", funcIdx: createBufIdx });
        fctx.body.push({ op: "local.set", index: bufferLocal });
        fctx.body.push({ op: "ref.null.extern" });
        fctx.body.push({ op: "local.set", index: pendingThrowLocal });

        // Wrap body in a block so return can br out
        // Use pushBody/popBody so the outer body stays reachable for global-index
        // fixups when new string-constant imports are added during body compilation.
        const savedGenBody = pushBody(fctx);

        fctx.generatorReturnDepth = 0;
        fctx.blockDepth++;
        for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]!++;
        for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]!++;

        // (#2641) Hoist var + let/const so a generator-method-local that shadows
        // a same-named module variable gets its own Wasm local (mirrors the
        // free-function generator path in function-body.ts). Hoist into the
        // same fctx, inside the pushBody scope, before the body loop.
        if (ctx.nativeStrings && ctx.anyStrTypeIdx >= 0) {
          const presize = new Map<ts.VariableDeclaration, StringBuilderPresizeInfo>();
          const builders = detectStringBuilders(ctx, member.body, presize);
          if (builders.size > 0) fctx.pendingStringBuilders = builders;
          if (presize.size > 0) fctx.stringBuilderPresize = presize;
        }
        hoistVarDeclarations(ctx, fctx, member.body.statements);
        hoistLetConstWithTdz(ctx, fctx, member.body.statements);

        for (const stmt of member.body.statements) {
          compileStatement(ctx, fctx, stmt);
        }

        fctx.blockDepth--;
        for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]!--;
        for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]!--;
        fctx.generatorReturnDepth = undefined;

        const bodyInstrs = fctx.body;
        popBody(fctx, savedGenBody);

        // Wrap generator body block in try/catch to capture exceptions as pending throw
        const tagIdx = ensureExnTag(ctx);
        const getCaughtIdx = ctx.funcMap.get("__get_caught_exception");
        const catchBody: Instr[] = [{ op: "local.set", index: pendingThrowLocal }];
        const catchAllBody: Instr[] =
          getCaughtIdx !== undefined
            ? [
                { op: "call", funcIdx: getCaughtIdx },
                { op: "local.set", index: pendingThrowLocal },
              ]
            : [];
        fctx.body.push(
          buildTargetTaggedTry(
            ctx,
            { kind: "empty" },
            [{ op: "block", blockType: { kind: "empty" }, body: bodyInstrs }],
            [{ tagIdx, body: catchBody }],
            catchAllBody.length > 0 ? catchAllBody : undefined,
          ),
        );

        // Return __create_generator or __create_async_generator depending on async flag
        const createGenName = isAsyncMethod ? "__create_async_generator" : "__create_generator";
        // (#2865) Record legacy-buffer async gens so the .next() dispatch keeps a host miss arm.
        if (createGenName === "__create_async_generator") ctx.asyncGenLegacyBufferEmitted = true;
        ctx.legacyGenBufferEmitted = true; // (#3132) sync OR async legacy buffer emitted
        const createGenIdx = ctx.funcMap.get(createGenName)!;
        fctx.body.push({ op: "local.get", index: bufferLocal });
        fctx.body.push({ op: "local.get", index: pendingThrowLocal });
        fctx.body.push({ op: "call", funcIdx: createGenIdx });
      } else if (member.body) {
        // (#2641) Hoist var + let/const BEFORE the body loop so a method-local
        // `let`/`const` shadowing a same-named module variable gets its own Wasm
        // local rather than aliasing the module global (the #2641 invalid-Wasm
        // symptom under native strings; a silent miscompilation otherwise).
        // Mirrors free functions in function-body.ts.
        if (ctx.nativeStrings && ctx.anyStrTypeIdx >= 0) {
          const presize = new Map<ts.VariableDeclaration, StringBuilderPresizeInfo>();
          const builders = detectStringBuilders(ctx, member.body, presize);
          if (builders.size > 0) fctx.pendingStringBuilders = builders;
          if (presize.size > 0) fctx.stringBuilderPresize = presize;
        }
        hoistVarDeclarations(ctx, fctx, member.body.statements);
        hoistLetConstWithTdz(ctx, fctx, member.body.statements);
        for (const stmt of member.body.statements) {
          compileStatement(ctx, fctx, stmt);
        }
      }

      // Ensure valid return for non-void, non-generator methods
      if (fctx.returnType && !isGeneratorMethod) {
        const lastInstr = fctx.body[fctx.body.length - 1];
        if (!lastInstr || lastInstr.op !== "return") {
          if (fctx.returnType.kind === "f64") {
            fctx.body.push({ op: "f64.const", value: 0 });
          } else if (fctx.returnType.kind === "i32") {
            fctx.body.push({ op: "i32.const", value: 0 });
          } else if (fctx.returnType.kind === "externref") {
            fctx.body.push({ op: "ref.null.extern" });
          } else if (fctx.returnType.kind === "ref" || fctx.returnType.kind === "ref_null") {
            fctx.body.push({
              op: "ref.null",
              typeIdx: fctx.returnType.typeIdx,
            });
          }
        }
      }

      cacheStringLiterals(ctx, fctx);
      deduplicateLocals(fctx);
      func.locals = fctx.locals;
      func.body = fctx.body;
      ctx.currentFunc = null;
    }
  }

  // Compile getter/setter accessor bodies
  // Track which accessors have been compiled to avoid overwriting when
  // both static and instance accessors share the same computed property name.
  const compiledAccessors = new Set<string>();
  for (const member of decl.members) {
    if (ts.isGetAccessorDeclaration(member) && member.name) {
      if (skipExactPreparedClassBody(ctx, member, routing)) continue;
      const propName = resolveClassMemberName(ctx, member.name);
      if (propName === undefined) continue; // dynamic computed name — skip
      const getterName = `${className}_get_${propName}`;
      if (compiledAccessors.has(getterName)) continue; // already compiled
      compiledAccessors.add(getterName);
      const getterLocalIdx = funcByName.get(classMemberFuncKey(ctx, getterName)); // (#1983)
      if (getterLocalIdx === undefined) continue;

      const func = ctx.mod.functions[getterLocalIdx]!;
      if (routing?.skipBodies.has(getterName)) {
        if (!routing.preserveSkippedBodies?.has(getterName)) {
          func.body = [{ op: "unreachable" }];
        }
        routing.skippedNames.push(getterName);
        continue;
      }
      assertDirectClassBodyAllowed(ctx, getterName, member);
      const sig = ctx.checker.getSignatureFromDeclaration(member);
      const retType = sig ? ctx.checker.getReturnTypeOfSignature(sig) : undefined;

      const params: { name: string; type: ValType }[] = [
        { name: "this", type: { kind: "ref", typeIdx: structTypeIdx } },
      ];

      // (#1681) Static accessor bodies reach `this` as the class-constructor
      // global (externref), not a per-instance struct. Mark the fctx static +
      // tag the enclosing class so `this.<prop>` routing in member-access /
      // assignment resolves through the static-global path instead of casting
      // the externref to the class struct (invalid `extern.convert_any`).
      const getterIsStatic = hasStaticModifier(member);

      const fctx: FunctionContext = {
        name: getterName,
        params,
        locals: [],
        localMap: new Map(),
        returnType: retType && !isVoidType(retType) ? resolveWasmType(ctx, retType) : null,
        body: [],
        blockDepth: 0,
        breakStack: [],
        continueStack: [],
        labelMap: new Map(),
        savedBodies: [],
        enclosingClassName: className,
        isStaticContext: getterIsStatic ? true : undefined,
      };
      fctx.activationEntryBody = fctx.body;

      // Re-resolve getter function type (see method type re-resolution above)
      {
        const resolvedParams = params.map((p) => p.type);
        const resolvedResults: ValType[] = fctx.returnType ? [fctx.returnType] : [];
        const updatedTypeIdx = addFuncType(ctx, resolvedParams, resolvedResults, `${getterName}_type`);
        if (updatedTypeIdx !== func.typeIdx) {
          func.typeIdx = updatedTypeIdx;
        }
      }

      for (let i = 0; i < params.length; i++) {
        fctx.localMap.set(params[i]!.name, i);
      }

      ctx.currentFunc = fctx;

      if (member.body) {
        // (#2641) Hoist so a getter-body local shadowing a module variable gets
        // its own Wasm local (same vulnerability as method/ctor bodies).
        if (ctx.nativeStrings && ctx.anyStrTypeIdx >= 0) {
          const presize = new Map<ts.VariableDeclaration, StringBuilderPresizeInfo>();
          const builders = detectStringBuilders(ctx, member.body, presize);
          if (builders.size > 0) fctx.pendingStringBuilders = builders;
          if (presize.size > 0) fctx.stringBuilderPresize = presize;
        }
        hoistVarDeclarations(ctx, fctx, member.body.statements);
        hoistLetConstWithTdz(ctx, fctx, member.body.statements);
        for (const stmt of member.body.statements) {
          compileStatement(ctx, fctx, stmt);
        }
      }

      // Ensure valid return for non-void getters
      if (fctx.returnType) {
        const lastInstr = fctx.body[fctx.body.length - 1];
        if (!lastInstr || lastInstr.op !== "return") {
          if (fctx.returnType.kind === "f64") {
            fctx.body.push({ op: "f64.const", value: 0 });
          } else if (fctx.returnType.kind === "i32") {
            fctx.body.push({ op: "i32.const", value: 0 });
          } else if (fctx.returnType.kind === "externref") {
            fctx.body.push({ op: "ref.null.extern" });
          } else if (fctx.returnType.kind === "ref" || fctx.returnType.kind === "ref_null") {
            fctx.body.push({
              op: "ref.null",
              typeIdx: fctx.returnType.typeIdx,
            });
          }
        }
      }

      cacheStringLiterals(ctx, fctx);
      deduplicateLocals(fctx);
      func.locals = fctx.locals;
      func.body = fctx.body;
      ctx.currentFunc = null;
    }

    if (ts.isSetAccessorDeclaration(member) && member.name) {
      if (skipExactPreparedClassBody(ctx, member, routing)) continue;
      const propName = resolveClassMemberName(ctx, member.name);
      if (propName === undefined) continue; // dynamic computed name — skip
      const setterName = `${className}_set_${propName}`;
      if (compiledAccessors.has(setterName)) continue; // already compiled
      compiledAccessors.add(setterName);
      const setterLocalIdx = funcByName.get(classMemberFuncKey(ctx, setterName)); // (#1983)
      if (setterLocalIdx === undefined) continue;

      const func = ctx.mod.functions[setterLocalIdx]!;
      if (routing?.skipBodies.has(setterName)) {
        if (!routing.preserveSkippedBodies?.has(setterName)) {
          func.body = [{ op: "unreachable" }];
        }
        routing.skippedNames.push(setterName);
        continue;
      }
      assertDirectClassBodyAllowed(ctx, setterName, member);

      // First param is self, remaining are the setter parameters
      const params: { name: string; type: ValType }[] = [
        { name: "this", type: { kind: "ref", typeIdx: structTypeIdx } },
      ];
      for (let pi = 0; pi < member.parameters.length; pi++) {
        const param = member.parameters[pi]!;
        const paramName = ts.isIdentifier(param.name) ? param.name.text : `__param${pi}`;
        let wasmType = resolveClassAccessorParameterType(ctx, member, param);
        // Widen ref to ref_null for params with defaults or optional params (#702)
        if ((param.initializer || param.questionToken) && wasmType.kind === "ref") {
          wasmType = { kind: "ref_null", typeIdx: (wasmType as { kind: "ref"; typeIdx: number }).typeIdx };
        }
        params.push({ name: paramName, type: wasmType });
      }

      // (#1681) See the getter site above — static setter bodies reach `this`
      // as the class-constructor global, so mark the fctx static.
      const setterIsStatic = hasStaticModifier(member);

      const fctx: FunctionContext = {
        name: setterName,
        params,
        locals: [],
        localMap: new Map(),
        returnType: null, // setters always return void
        body: [],
        blockDepth: 0,
        breakStack: [],
        continueStack: [],
        labelMap: new Map(),
        savedBodies: [],
        enclosingClassName: className,
        isStaticContext: setterIsStatic ? true : undefined,
      };
      fctx.activationEntryBody = fctx.body;

      // Re-resolve setter function type (see method type re-resolution above)
      {
        const resolvedParams = params.map((p) => p.type);
        const resolvedResults: ValType[] = [];
        const updatedTypeIdx = addFuncType(ctx, resolvedParams, resolvedResults, `${setterName}_type`);
        if (updatedTypeIdx !== func.typeIdx) {
          func.typeIdx = updatedTypeIdx;
        }
      }

      for (let i = 0; i < params.length; i++) {
        fctx.localMap.set(params[i]!.name, i);
      }

      ctx.currentFunc = fctx;

      // Emit default-value initialization for setter parameters with initializers (#377)
      const defaultArgcLocal = member.parameters.some((param, i) => {
        if (!param.initializer) return false;
        return paramDefaultNeedsArgc(params[i + 1]?.type);
      })
        ? cacheParamDefaultArgc(ctx, fctx)
        : undefined;
      for (let pi = 0; pi < member.parameters.length; pi++) {
        const param = member.parameters[pi]!;
        if (!param.initializer) continue;

        const paramLocalIdx = pi + 1; // account for 'this' param
        const paramType = params[paramLocalIdx]!.type;

        // Pre-ensure `__extern_is_undefined` before compiling the initializer —
        // see constructor site above for the rationale.
        if (paramType.kind === "externref") {
          ensureLateImport(ctx, "__extern_is_undefined", [{ kind: "externref" }], [{ kind: "i32" }]);
          flushLateImportShifts(ctx, fctx);
        }

        // Build the "then" block: compile default expression, local.set
        const savedBody = pushBody(fctx);
        // (#1451) For array binding patterns with externref param, force the
        // default's array literals to compile as vec (not tuple). See
        // function-body.ts:701 / method site above for full rationale.
        const setterIsArrayPatternExternref = ts.isArrayBindingPattern(param.name) && paramType.kind === "externref";
        const setterPrevForceVec = (ctx as unknown as { _arrayLiteralForceVec?: boolean })._arrayLiteralForceVec;
        if (setterIsArrayPatternExternref) {
          (ctx as unknown as { _arrayLiteralForceVec?: boolean })._arrayLiteralForceVec = true;
        }
        let getSetDfltType: ValType | null;
        try {
          getSetDfltType = compileExpression(ctx, fctx, param.initializer, paramType);
        } finally {
          if (setterIsArrayPatternExternref) {
            (ctx as unknown as { _arrayLiteralForceVec?: boolean })._arrayLiteralForceVec = setterPrevForceVec;
          }
        }
        if (getSetDfltType && !valTypesMatch(getSetDfltType, paramType)) {
          coerceType(ctx, fctx, getSetDfltType, paramType);
        }
        fctx.body.push({ op: "local.set", index: paramLocalIdx });
        const thenInstrs = fctx.body;
        popBody(fctx, savedBody);

        emitClassParamDefaultCheck(ctx, fctx, paramLocalIdx, paramType, thenInstrs, pi, defaultArgcLocal);
      }

      if (member.body) {
        // (#2641) Hoist so a setter-body local shadowing a module variable gets
        // its own Wasm local (same vulnerability as method/ctor bodies).
        if (ctx.nativeStrings && ctx.anyStrTypeIdx >= 0) {
          const presize = new Map<ts.VariableDeclaration, StringBuilderPresizeInfo>();
          const builders = detectStringBuilders(ctx, member.body, presize);
          if (builders.size > 0) fctx.pendingStringBuilders = builders;
          if (presize.size > 0) fctx.stringBuilderPresize = presize;
        }
        hoistVarDeclarations(ctx, fctx, member.body.statements);
        hoistLetConstWithTdz(ctx, fctx, member.body.statements);
        for (const stmt of member.body.statements) {
          compileStatement(ctx, fctx, stmt);
        }
      }

      cacheStringLiterals(ctx, fctx);
      deduplicateLocals(fctx);
      func.locals = fctx.locals;
      func.body = fctx.body;
      ctx.currentFunc = null;
    }
  }
}

/**
 * (#2637 B2.3) Fill `${className}_new__onhost` — the run-on-host-`this` variant
 * of a `class … extends Promise` user constructor.
 *
 * THE CORRECTNESS TRAP: the direct-new body `${className}_new` (the B1 path)
 * calls `__new_Promise(exec)` to ALLOCATE its own host Promise into `$__self`.
 * Under V8's `NewPromiseCapability(C)` the runtime synthesizes a JS ctor that
 * does `super(exec)` (allocating V8's capability promise) and then calls the
 * registered wasm body on THAT instance. If we registered `${className}_new`
 * directly, it would call `__new_Promise` AGAIN — a SECOND promise — and run
 * the user side effects on the wrong `$__self`, leaving V8's real `this`
 * untouched. So we emit this SEPARATE body whose `$__self` is BOUND to the
 * host-provided `this` (reachable as `__current_this`, installed by
 * `__call_fn_method_1`), and whose `super(exec)` is lowered in `onHost` mode
 * (no `__new_Promise`; arguments evaluated for side effects only; proto/brand
 * wiring re-applied to the host promise). `${className}_new` is left untouched,
 * so the B1 direct-new path does not regress.
 *
 * Only invoked for `isPromiseSubclassWithUserCtor` classes, which are always
 * externref-backed with `splitInit = false` and a user `ctor` — a strict
 * subset of the direct-new shape, so this mirrors only that lane.
 */
function emitPromiseSubclassOnHostCtor(
  ctx: CodegenContext,
  decl: ts.ClassDeclaration | ts.ClassExpression,
  funcByName: Map<string, number>,
  className: string,
  ctor: ts.ConstructorDeclaration,
): void {
  const onHostName = `${className}_new__onhost`;
  const onHostLocalIdx = funcByName.get(classMemberFuncKey(ctx, onHostName));
  if (onHostLocalIdx === undefined) return; // not pre-registered (defensive)
  const func = ctx.mod.functions[onHostLocalIdx]!;

  // Build the param list identically to the direct-new ctor (#2086 shared
  // prefix rule + user ctor params). A Promise subclass has no struct parent
  // init to forward to, so `implicitPrefixParams` is empty in practice, but we
  // compute it from the same helper for parity.
  const params: { name: string; type: ValType }[] = [];
  const { prefixParams: implicitPrefixParams } = computeImplicitDerivedCtorPrefix(ctx, decl, className, ctor);
  params.push(...implicitPrefixParams);
  for (let pi = 0; pi < ctor.parameters.length; pi++) {
    const param = ctor.parameters[pi]!;
    const paramName = ts.isIdentifier(param.name) ? param.name.text : `__param${pi}`;
    const paramType = ctx.checker.getTypeAtLocation(param);
    let wasmType = resolveWasmType(ctx, paramType);
    if ((param.initializer || param.questionToken) && wasmType.kind === "ref") {
      wasmType = { kind: "ref_null", typeIdx: (wasmType as { kind: "ref"; typeIdx: number }).typeIdx };
    }
    params.push({ name: paramName, type: wasmType });
  }

  const fctx: FunctionContext = {
    name: onHostName,
    params,
    locals: [],
    localMap: new Map(),
    returnType: { kind: "externref" },
    body: [],
    blockDepth: 0,
    breakStack: [],
    continueStack: [],
    labelMap: new Map(),
    savedBodies: [],
    isConstructor: true,
    isDerivedConstructor: ctx.classParentMap.has(className),
    // The host installs the capability promise into `__current_this` before
    // dispatching this body via `__call_fn_method_1`; `this` reads that global.
    readsCurrentThis: true,
  };
  fctx.activationEntryBody = fctx.body;

  // Re-resolve the function type now that all struct types are registered
  // (parity with the direct-new ctor's re-resolution).
  {
    const resolvedParams = params.map((p) => p.type);
    const updatedTypeIdx = addFuncType(ctx, resolvedParams, [{ kind: "externref" }], `${onHostName}_type`);
    if (updatedTypeIdx !== func.typeIdx) func.typeIdx = updatedTypeIdx;
  }

  for (let i = 0; i < params.length; i++) {
    fctx.localMap.set(params[i]!.name, i);
  }

  // `$__self` (the instance) is the host-provided `this`: read `__current_this`
  // (externref) instead of allocating via `__new_Promise`. This is the heart of
  // the run-on-host-`this` mode.
  const selfLocal = allocLocal(fctx, "__self", { kind: "externref" });
  const currentThisGlobalIdx = ensureCurrentThisGlobal(ctx);
  fctx.body.push({ op: "global.get", index: currentThisGlobalIdx });
  fctx.body.push({ op: "local.set", index: selfLocal });
  fctx.localMap.set("this", selfLocal);
  ctx.currentFunc = fctx;

  // Default-value initialization for ctor params with initializers — identical
  // to the direct-new ctor path (defaultInitBase = 0 for a user ctor).
  {
    const defaultInitParams = ctor.parameters;
    const defaultArgcLocal = defaultInitParams.some((param, i) => {
      if (!param.initializer) return false;
      return paramDefaultNeedsArgc(params[i]?.type);
    })
      ? cacheParamDefaultArgc(ctx, fctx)
      : undefined;
    for (let i = 0; i < defaultInitParams.length; i++) {
      const param = defaultInitParams[i]!;
      if (!param.initializer) continue;
      const paramIdx = i;
      const paramType = params[paramIdx]!.type;
      if (paramType.kind === "externref") {
        ensureLateImport(ctx, "__extern_is_undefined", [{ kind: "externref" }], [{ kind: "i32" }]);
        flushLateImportShifts(ctx, fctx);
      }
      const savedBody = pushBody(fctx);
      const ctorIsArrayPatternExternref = ts.isArrayBindingPattern(param.name) && paramType.kind === "externref";
      const ctorPrevForceVec = (ctx as unknown as { _arrayLiteralForceVec?: boolean })._arrayLiteralForceVec;
      if (ctorIsArrayPatternExternref) {
        (ctx as unknown as { _arrayLiteralForceVec?: boolean })._arrayLiteralForceVec = true;
      }
      let ctorDfltType: ValType | null;
      try {
        ctorDfltType = compileExpression(ctx, fctx, param.initializer, paramType);
      } finally {
        if (ctorIsArrayPatternExternref) {
          (ctx as unknown as { _arrayLiteralForceVec?: boolean })._arrayLiteralForceVec = ctorPrevForceVec;
        }
      }
      if (ctorDfltType && !valTypesMatch(ctorDfltType, paramType)) {
        coerceType(ctx, fctx, ctorDfltType, paramType);
      }
      fctx.body.push({ op: "local.set", index: paramIdx });
      const thenInstrs = fctx.body;
      popBody(fctx, savedBody);
      emitClassParamDefaultCheck(ctx, fctx, paramIdx, paramType, thenInstrs, i, defaultArgcLocal);
    }
  }

  // A Promise subclass user ctor always calls `super(exec)` (a derived ctor
  // that never does is a ReferenceError on construct, handled by the direct-new
  // body; the runtime only reaches this body after V8's own `super(exec)` has
  // already constructed `this`). Compile the body statements; `super(...)` is
  // lowered in run-on-host mode (skip `__new_Promise`, keep `$__self`).
  const ctorMissingSuper = ctor.body !== undefined && !constructorBodyHasSuperCall(ctor.body);
  if (ctorMissingSuper) {
    emitThrowReferenceError(
      ctx,
      fctx,
      "Must call super constructor in derived class before accessing 'this' or returning from derived constructor",
    );
  } else if (ctor.body) {
    if (ctx.nativeStrings && ctx.anyStrTypeIdx >= 0) {
      const presize = new Map<ts.VariableDeclaration, StringBuilderPresizeInfo>();
      const builders = detectStringBuilders(ctx, ctor.body, presize);
      if (builders.size > 0) fctx.pendingStringBuilders = builders;
      if (presize.size > 0) fctx.stringBuilderPresize = presize;
    }
    hoistVarDeclarations(ctx, fctx, ctor.body.statements);
    hoistLetConstWithTdz(ctx, fctx, ctor.body.statements);
    for (const stmt of ctor.body.statements) {
      if (
        ts.isExpressionStatement(stmt) &&
        ts.isCallExpression(stmt.expression) &&
        stmt.expression.expression.kind === ts.SyntaxKind.SuperKeyword
      ) {
        compileSuperCall(ctx, fctx, className, selfLocal, stmt.expression, [], /* onHost */ true);
        continue;
      }
      compileStatement(ctx, fctx, stmt);
    }
  }

  // NB: intentionally NO `__tag_user_class` tagging and NO
  // `emitSetSubclassProto` here (unlike the direct-new ctor). V8 constructed
  // `this` via `new C(exec)` where `C` is the `__promise_subclass_ctor`
  // synthetic, so the instance's [[Prototype]] is already `C.prototype` and
  // `instance instanceof SubPromise` / `instance.constructor === SubPromise`
  // resolve through the engine's native prototype walk against that SAME
  // synthetic (the #1977 identity unification — the value-read `SubPromise`
  // returns `C`). Touching either registry here would re-point identity to the
  // unrelated `subclassCtors`/`__tag_user_class` synthetic and break asserts
  // #1/#2.

  // Return the (host-provided) instance.
  fctx.body.push({ op: "local.get", index: selfLocal });

  cacheStringLiterals(ctx, fctx);
  deduplicateLocals(fctx);
  func.locals = fctx.locals;
  func.body = fctx.body;
  ctx.currentFunc = null;
}

/**
 * Compile a super(args) call inside a child constructor.
 * This runs the parent constructor's field-initialization logic inline:
 * for each parent field, evaluate the corresponding super argument and
 * store it into the child struct (which includes parent fields at the start).
 */
export function compileSuperCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  childClassName: string,
  selfLocal: number,
  callExpr: ts.CallExpression,
  _allFields: FieldDef[],
  // (#2637 B2.3) run-on-host-`this` mode. When true, `selfLocal` is ALREADY
  // bound to a host-provided instance (V8's NewPromiseCapability promise,
  // installed as `__current_this` by `__call_fn_method_1` — see
  // `emitPromiseSubclassOnHostCtor`). The builtin-parent `super(exec)` must
  // therefore NOT allocate a SECOND instance via `__new_<Parent>` (the
  // double-`__new_Promise` correctness trap): the executor's argument
  // expressions are still evaluated left-to-right for their side effects
  // (§13.3.7.1 ArgumentListEvaluation), but the result is discarded and
  // `selfLocal` is left untouched. Proto/brand wiring still runs on the
  // host instance. Only ever set for an externref-backed builtin parent.
  onHost = false,
): void {
  const parentClassName = ctx.classParentMap.get(childClassName);
  if (!parentClassName) return;

  // (#1366a) Externref-backed subclass (extends Error / TypeError / ...).
  // `super(msg)` lowers to `__self = __new_<Parent>(msg)`. The host import
  // produces a real JS Error object whose internal slots (.name/.message/
  // .stack) are correctly populated, and whose [[Prototype]] is set by the
  // JS runtime — which is the most behaviour we can capture without a
  // newTarget-threading helper (deferred to #1366b/c).
  const builtinParent = ctx.classBuiltinParentMap.get(childClassName);
  if (builtinParent) {
    const args = callExpr.arguments;
    // (#2637 B2.3) run-on-host-`this`: V8 already performed `super(exec)`
    // inside the synthesized JS ctor (`__promise_subclass_ctor`), so the wasm
    // body must NOT re-allocate. Evaluate the super arguments for their side
    // effects (spec-mandated §13.3.7.1 ArgumentListEvaluation), then keep the
    // host-provided `selfLocal` untouched.
    //
    // Crucially, do NOT re-run `emitSetSubclassProto` / `emitSetSubclassUserBrand`
    // here: V8 constructed `this` via `new C(exec)` where `C` is the
    // `__promise_subclass_ctor` synthetic, so the instance's [[Prototype]] is
    // ALREADY `C.prototype` — the same object the value-read `SubPromise`
    // resolves to (the #1977 identity unification). `__set_subclass_proto`
    // would re-point it to a DIFFERENT synthetic (`subclassCtors`, the #1933
    // registry), breaking `instance.constructor === SubPromise` /
    // `instance instanceof SubPromise` (ctx-ctor asserts #1/#2). The direct-new
    // path still needs the proto fix (its instance comes from the bare
    // `__new_Promise`, proto `Promise.prototype`), so that branch is untouched.
    if (onHost) {
      for (const arg of args) {
        evaluateArgumentForSideEffects(ctx, fctx, arg);
      }
      return;
    }
    const hasSpread = args.some((a) => ts.isSpreadElement(a));
    const importName = getParentConstructorImportName(ctx, builtinParent);
    const forwardArity = getBuiltinConstructorForwardArity(ctx, builtinParent);
    const forwardParams = externrefParams(forwardArity);
    // Standalone / WASI: explicit `super(...)` routes through the same shared
    // native-`__new_<Parent>` dispatch ladder as the implicit forwarder
    // (`resolveStandaloneBuiltinSuperCtorIdx`). Args are still evaluated below
    // and forwarded (Array honors them; Object/vec builtins ignore them).
    // JS-host mode / parents with no native ctor yet keep the host import.
    let funcIdx: number | undefined;
    const nativeCtorIdx = resolveStandaloneBuiltinSuperCtorIdx(ctx, builtinParent, forwardArity);
    if (nativeCtorIdx !== undefined) {
      funcIdx = nativeCtorIdx ?? undefined;
    } else {
      funcIdx = ensureLateImport(ctx, importName, forwardParams, [{ kind: "externref" }]);
      flushLateImportShifts(ctx, fctx);
    }
    if (funcIdx !== undefined) {
      const flatArgs = hasSpread ? flattenStaticallyKnownArgs(args) : [...args];
      if (flatArgs) {
        for (let i = 0; i < forwardArity; i++) {
          if (i < flatArgs.length) {
            compileExternrefArgument(ctx, fctx, flatArgs[i]!);
          } else {
            emitUndefined(ctx, fctx);
          }
        }
        for (let i = forwardArity; i < flatArgs.length; i++) {
          evaluateArgumentForSideEffects(ctx, fctx, flatArgs[i]!);
        }
      } else {
        // (#1551) Non-literal spread cannot be unpacked here yet. Evaluate
        // operands left-to-right for side effects, then call the parent with an
        // all-undefined argument list that the runtime trims to `super()`.
        for (const arg of args) {
          evaluateArgumentForSideEffects(ctx, fctx, arg);
        }
        for (let i = 0; i < forwardArity; i++) {
          emitUndefined(ctx, fctx);
        }
      }
      fctx.body.push({ op: "call", funcIdx });
    } else {
      // If the import is unavailable (standalone/WASI), preserve the old
      // best-effort fallback: evaluate arguments, then use the first value (or
      // null) as the instance.
      if (args.length > 0 && !ts.isSpreadElement(args[0]!)) {
        compileExternrefArgument(ctx, fctx, args[0]!);
        for (let i = 1; i < args.length; i++) {
          evaluateArgumentForSideEffects(ctx, fctx, args[i]!);
        }
      } else {
        for (const arg of args) {
          evaluateArgumentForSideEffects(ctx, fctx, arg);
        }
        fctx.body.push({ op: "ref.null.extern" });
      }
    }
    fctx.body.push({ op: "local.set", index: selfLocal });
    // (#1455) Adjust the instance's [[Prototype]] to `childClassName.prototype`
    // so `instance instanceof childClassName` returns true. Without this step
    // the chain only reaches `<builtinParent>.prototype`.
    emitSetSubclassProto(ctx, fctx, selfLocal, childClassName, builtinParent);
    // (#2188) Brand the standalone instance with this subclass's tag so sibling
    // `extends Error` subclasses are distinguishable by instanceof.
    emitSetSubclassUserBrand(ctx, fctx, selfLocal, childClassName);
    return;
  }

  // (#1965) `super(args)` is a REAL call to the parent's constructor-init
  // function `${parent}_init(args..., self)`. The parent binds its
  // parameters, runs its field initializers and its full ctor body (and
  // recursively chains to ITS parent via its own super()). The old
  // positional args→parent-struct-fields copy and the AST replay of
  // ancestor field initializers are gone — the real call subsumes both.
  // Passing `self: (ref $Child)` where the init expects `(ref $Parent)` is
  // direct WasmGC subsumption ($Child <: $Parent via superTypeIdx).
  const parentInitName = `${parentClassName}_init`;
  const parentInitIdx = ctx.funcMap.get(parentInitName);
  if (parentInitIdx === undefined) {
    // Parent is not a struct-backed user class with an init (should not
    // happen — builtin parents took the branch above). Evaluate args for
    // side effects to preserve §13.3.7.1 ArgumentListEvaluation.
    for (const arg of callExpr.arguments) {
      evaluateArgumentForSideEffects(ctx, fctx, arg);
    }
    return;
  }
  const initParamTypes = getFuncParamTypes(ctx, parentInitIdx) ?? [];
  // Strip the trailing `self` param — callers supply it separately below.
  const paramTypes = initParamTypes.slice(0, Math.max(0, initParamTypes.length - 1));
  const restInfo = ctx.funcRestParams.get(parentInitName);
  const args = callExpr.arguments;
  const hasSpread = args.some((a) => ts.isSpreadElement(a));
  // Statically-known spreads (array literals of literals) flatten to
  // positional args; runtime spreads fall through to the side-effect path.
  const flatArgs: ts.Expression[] | undefined = hasSpread ? (flattenStaticallyKnownArgs(args) ?? undefined) : [...args];

  let actualArgCount = 0;
  if (restInfo && !hasSpread) {
    // Parent ctor has a rest parameter: pack trailing args into a vec, the
    // same shape regular rest-param call sites build.
    for (let i = 0; i < restInfo.restIndex; i++) {
      if (i < args.length) {
        compileExpression(ctx, fctx, args[i]!, paramTypes[i]);
      } else {
        pushDefaultValue(fctx, paramTypes[i] ?? { kind: "f64" }, ctx);
      }
    }
    const restArgCount = Math.max(0, args.length - restInfo.restIndex);
    fctx.body.push({ op: "i32.const", value: restArgCount });
    for (let i = restInfo.restIndex; i < args.length; i++) {
      compileExpression(ctx, fctx, args[i]!, restInfo.elemType);
    }
    fctx.body.push({
      op: "array.new_fixed",
      typeIdx: restInfo.arrayTypeIdx,
      length: restArgCount,
    });
    fctx.body.push({ op: "struct.new", typeIdx: restInfo.vecTypeIdx });
    actualArgCount = args.length;
  } else if (flatArgs) {
    // (#1551) ArgumentListEvaluation (§13.3.7.1 step 4) evaluates every
    // argument expression left-to-right; args beyond the parent's param
    // count are evaluated for side effects only and dropped.
    for (let i = 0; i < Math.min(flatArgs.length, paramTypes.length); i++) {
      compileExpression(ctx, fctx, flatArgs[i]!, paramTypes[i]);
    }
    for (let i = paramTypes.length; i < flatArgs.length; i++) {
      const argResult = compileExpression(ctx, fctx, flatArgs[i]!);
      if (argResult !== null) {
        fctx.body.push({ op: "drop" });
      }
    }
    for (let i = flatArgs.length; i < paramTypes.length; i++) {
      pushDefaultValue(fctx, paramTypes[i]!, ctx);
    }
    actualArgCount = flatArgs.length;
  } else {
    // Runtime spread that cannot be statically unpacked (#1551): evaluate
    // operands left-to-right for side effects, then call the parent with
    // default-padded params and argc 0 so the parent's own defaults fire.
    for (const arg of args) {
      evaluateArgumentForSideEffects(ctx, fctx, arg);
    }
    for (const t of paramTypes) {
      pushDefaultValue(fctx, t, ctx);
    }
    actualArgCount = 0;
  }
  // Let the parent's defaults/`arguments` machinery see the real arg count.
  maybeSetArgcForKnownCall(ctx, fctx, parentInitName, actualArgCount, paramTypes.length);
  fctx.body.push({ op: "local.get", index: selfLocal });
  // Re-resolve: compiling arguments may have added late imports and shifted
  // function indices.
  const finalInitIdx = ctx.funcMap.get(parentInitName) ?? parentInitIdx;
  fctx.body.push({ op: "call", funcIdx: finalInitIdx });
  // The init returns the instance (constructor-return-override plumbing for
  // the direct-construction path); super() ignores it — `this` stays the
  // derived allocation. Parent return-override through super() is out of
  // scope (was equally unsupported by the positional-copy mechanism).
  fctx.body.push({ op: "drop" });
}
