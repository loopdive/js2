// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Class declaration collection and class body compilation.
 *
 * Extracted from codegen/index.ts (#1013).
 */
import { ts } from "../ts-api.js";
import { isVoidType, unwrapPromiseType } from "../checker/type-mapper.js";
import type { FieldDef, Instr, StructTypeDef, ValType } from "../ir/types.js";
import { isHostConstructibleBuiltin } from "./builtin-tags.js";
import { popBody, pushBody } from "./context/bodies.js";
import { reportError } from "./context/errors.js";
import { allocLocal, deduplicateLocals } from "./context/locals.js";
import type { CodegenContext, FunctionContext, OptionalParamInfo } from "./context/types.js";
import {
  buildDestructureNullThrow,
  destructureParamArray,
  destructureParamObject,
  isNullOrUndefinedLiteral,
} from "./destructuring-params.js";
import { emitThrowReferenceError } from "./expressions/helpers.js";
import { bodyUsesArguments } from "./helpers/body-uses-arguments.js";
import {
  cacheStringLiterals,
  extractConstantDefault,
  hasAbstractModifier,
  hasStaticModifier,
  resolveWasmType,
} from "./index.js";
import { emitUndefined } from "./expressions/late-imports.js";
import { addStringConstantGlobal, ensureExnTag, nextModuleGlobalIdx } from "./registry/imports.js";
import { addFuncType, getArrTypeIdxFromVec, getOrRegisterVecType } from "./registry/types.js";
import {
  cacheParamDefaultArgc,
  emitF64ParamSentinelCheck,
  emitParamDefaultArgMissingCheck,
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
      const cd = extractConstantDefault(param.initializer, type);
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
    const ancCtor = ancDecl?.members.find(ts.isConstructorDeclaration) as ts.ConstructorDeclaration | undefined;
    if (ancCtor) return ancCtor.parameters;
    anc = ctx.classParentMap.get(anc);
  }
  return undefined;
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
  addStringConstantGlobal(ctx, subName);
  addStringConstantGlobal(ctx, parentName);
  const subNameGlobal = ctx.stringGlobalMap.get(subName);
  const parentNameGlobal = ctx.stringGlobalMap.get(parentName);
  if (subNameGlobal === undefined || parentNameGlobal === undefined) {
    // String pool not available (very unusual) — skip silently.
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
          parentClassName = baseExpr.text;
          // Guard against circular inheritance (e.g., class X extends X)
          if (parentClassName === className) {
            parentClassName = undefined;
            break;
          }
          parentStructTypeIdx = ctx.structMap.get(parentClassName);
          parentFields = ctx.structFields.get(parentClassName) ?? [];
          // Record parent-child relationship
          ctx.classParentMap.set(className, parentClassName);
          // (#1366a) Detect built-in parent that is host-constructible (Error
          // family). Such subclasses get an externref-backed instance: the
          // constructor returns externref and `super(...)` lowers to
          // `__new_<Parent>(...)`. We deliberately keep parentStructTypeIdx
          // undefined so the existing "root struct" path still fires for any
          // user-class collection bookkeeping (struct registration, tag).
          if (parentStructTypeIdx === undefined && isHostConstructibleBuiltin(parentClassName)) {
            ctx.classBuiltinParentMap.set(className, parentClassName);
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
  const ctor = decl.members.find(ts.isConstructorDeclaration) as ts.ConstructorDeclaration | undefined;
  const ownFields: FieldDef[] = [];

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
        const fieldType = resolveWasmType(ctx, fieldTsType);
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
        const fieldType = resolveWasmType(ctx, fieldTsType);
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
  }

  // Update the placeholder struct type with resolved fields
  const structDef: StructTypeDef = { kind: "struct", name: className, fields };
  if (parentStructTypeIdx !== undefined) {
    structDef.superTypeIdx = parentStructTypeIdx;
  }
  ctx.mod.types[structTypeIdx] = structDef;
  ctx.structFields.set(className, fields);

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
  const implicitBuiltinParent = !ctor ? ctx.classBuiltinParentMap.get(className) : undefined;
  const implicitForwarderArity = implicitBuiltinParent
    ? getImplicitExternrefForwarderArity(ctx, decl, className, implicitBuiltinParent)
    : 0;
  if (implicitForwarderArity > 0) {
    ctorParams.push(...externrefParams(implicitForwarderArity));
  }
  // #2082: implicit ctor of a WasmGC-struct-backed derived class (no explicit
  // ctor, non-builtin parent) — forward the nearest ancestor ctor's params so
  // `new Dog("rex")` actually passes "rex" through to the replayed
  // `this.name = name` (spec §15.7.14 `constructor(...args){ super(...args) }`).
  const implicitStructCtorParams =
    !ctor && !implicitBuiltinParent ? findNearestAncestorCtorParams(ctx, className) : undefined;
  if (implicitStructCtorParams) {
    for (const param of implicitStructCtorParams) {
      const paramType = ctx.checker.getTypeAtLocation(param);
      let wasmType = resolveWasmType(ctx, paramType);
      if (param.initializer && wasmType.kind === "ref") {
        wasmType = { kind: "ref_null", typeIdx: (wasmType as { kind: "ref"; typeIdx: number }).typeIdx };
      }
      ctorParams.push(wasmType);
    }
  }
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
        let wasmType = resolveWasmType(ctx, paramType);
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
  const ctorFuncIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.funcMap.set(ctorName, ctorFuncIdx);

  ctx.mod.functions.push({
    name: ctorName,
    typeIdx: ctorTypeIdx,
    locals: [],
    body: [],
    exported: false,
  });

  // Register method functions (own methods defined on this class)
  // Skip abstract methods — they have no body and are implemented by subclasses
  const ownMethodNames = new Set<string>();
  for (const member of decl.members) {
    if (ts.isMethodDeclaration(member) && member.name) {
      const methodName = resolveClassMemberName(ctx, member.name);
      if (methodName === undefined) continue; // dynamic computed name — skip
      ownMethodNames.add(methodName);

      // Abstract methods have no body — skip generating a wasm function stub
      if (hasAbstractModifier(member)) continue;

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

      // Skip if a function with this name is already registered (e.g., when
      // both a static and instance method share the same name, they produce
      // the same function name — avoid creating duplicate placeholders).
      if (ctx.funcMap.has(fullName)) continue;

      // Static methods have no self parameter; instance methods get self: (ref $structTypeIdx)
      const methodParams: ValType[] = isStatic ? [] : [{ kind: "ref", typeIdx: structTypeIdx }];
      for (const param of member.parameters) {
        const paramType = ctx.checker.getTypeAtLocation(param);
        let wasmType = resolveWasmType(ctx, paramType);
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
        // Generator methods return externref (JS Generator object)
        methodResults = [{ kind: "externref" }];
      } else if (sig) {
        let retType = ctx.checker.getReturnTypeOfSignature(sig);
        if (isAsyncMethod) {
          retType = unwrapPromiseType(retType, ctx.checker);
        }
        if (!isVoidType(retType)) {
          methodResults = [resolveWasmType(ctx, retType)];
        }
      }

      // Track methods that read `arguments` (#1053) so callers can
      // populate the __extras_argv global with runtime args beyond the
      // formal param count.
      if (member.body && bodyUsesArguments(member.body)) {
        ctx.funcUsesArguments.add(fullName);
      }

      const methodTypeIdx = addFuncType(ctx, methodParams, methodResults, `${fullName}_type`);
      const methodFuncIdx = ctx.numImportFuncs + ctx.mod.functions.length;
      ctx.funcMap.set(fullName, methodFuncIdx);

      ctx.mod.functions.push({
        name: fullName,
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
      if (ctx.funcMap.has(getterName)) continue;
      // Getter takes self, returns the accessor return type
      const getterParams: ValType[] = [{ kind: "ref", typeIdx: structTypeIdx }];
      const sig = ctx.checker.getSignatureFromDeclaration(member);
      let getterResults: ValType[] = [];
      if (sig) {
        const retType = ctx.checker.getReturnTypeOfSignature(sig);
        if (!isVoidType(retType)) {
          getterResults = [resolveWasmType(ctx, retType)];
        }
      }

      const getterTypeIdx = addFuncType(ctx, getterParams, getterResults, `${getterName}_type`);
      const getterFuncIdx = ctx.numImportFuncs + ctx.mod.functions.length;
      ctx.funcMap.set(getterName, getterFuncIdx);

      ctx.mod.functions.push({
        name: getterName,
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
      if (ctx.funcMap.has(setterName)) continue;
      // Setter takes self + value, returns void
      const setterParams: ValType[] = [{ kind: "ref", typeIdx: structTypeIdx }];
      for (const param of member.parameters) {
        const paramType = ctx.checker.getTypeAtLocation(param);
        setterParams.push(resolveWasmType(ctx, paramType));
      }
      registerClassOptionalParams(ctx, setterName, member.parameters, setterParams, 1);

      const setterTypeIdx = addFuncType(ctx, setterParams, [], `${setterName}_type`);
      const setterFuncIdx = ctx.numImportFuncs + ctx.mod.functions.length;
      ctx.funcMap.set(setterName, setterFuncIdx);

      ctx.mod.functions.push({
        name: setterName,
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
    // Collect own accessor names for override detection
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
        if (key.startsWith(`${ancestor}_`) && !key.endsWith("_new") && !key.endsWith("_type")) {
          const suffix = key.substring(ancestor.length + 1);
          // Skip constructor-related entries
          if (suffix === "new" || suffix.startsWith("new_")) continue;
          // Check if this is a getter/setter (get_X or set_X)
          const getMatch = suffix.match(/^get_(.+)$/);
          const setMatch = suffix.match(/^set_(.+)$/);
          if (getMatch || setMatch) {
            // Accessor inheritance
            const accPropName = (getMatch || setMatch)![1]!;
            if (!ownAccessorNames.has(accPropName)) {
              const childFullName = `${className}_${suffix}`;
              if (!ctx.funcMap.has(childFullName)) {
                ctx.funcMap.set(childFullName, funcIdx);
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
            if (!ownMethodNames.has(suffix) && !ctx.funcMap.has(childFullName)) {
              ctx.funcMap.set(childFullName, funcIdx);
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
      const wasmType = resolveWasmType(ctx, propTsType);

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

/** Scan all function bodies for ref.func instructions and record their targets */
export function collectDeclaredFuncRefs(ctx: CodegenContext): void {
  const refs = new Set<number>();
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
    ctx.mod.declaredFuncRefs = [...refs].sort((a, b) => a - b);
  }
}

/** Compile constructor and method bodies for a class declaration */
export function compileClassBodies(
  ctx: CodegenContext,
  decl: ts.ClassDeclaration | ts.ClassExpression,
  funcByName: Map<string, number>,
  syntheticName?: string,
): void {
  const className = syntheticName ?? decl.name?.text;
  if (!className) {
    reportError(ctx, decl, "Cannot compile unnamed class");
    return;
  }
  const structTypeIdx = ctx.structMap.get(className);
  const fields = ctx.structFields.get(className);
  if (structTypeIdx === undefined || !fields) {
    reportError(ctx, decl, `Unknown class struct type: ${className}`);
    return;
  }

  // (#779a) For nested class declarations, an enclosing function may still be
  // mid-compilation (its `fctx.body` holds the captured-global copy emitted by
  // `promoteAccessorCapturesToGlobals`). Compiling constructor/method bodies
  // below overwrites `ctx.currentFunc`, so a string-constant import added
  // during a binding-pattern destructure (e.g. the "Cannot destructure ..."
  // message) would run `fixupModuleGlobalIndices` WITHOUT the enclosing body in
  // its shift set — leaving its already-emitted `global.set`/`global.get`
  // indices stale while the captured-global maps shift past them. Register the
  // enclosing function on the shift-tracking stacks so its body is shifted too
  // (mirrors the object-literal method path in literals.ts:1663-1666).
  const enclosingFunc = ctx.currentFunc;
  if (enclosingFunc) {
    ctx.funcStack.push(enclosingFunc);
    ctx.parentBodiesStack.push(enclosingFunc.body);
  }
  try {
    compileClassBodiesInner(ctx, decl, funcByName, className, structTypeIdx, fields);
  } finally {
    if (enclosingFunc) {
      ctx.funcStack.pop();
      ctx.parentBodiesStack.pop();
      ctx.currentFunc = enclosingFunc;
    }
  }
}

function compileClassBodiesInner(
  ctx: CodegenContext,
  decl: ts.ClassDeclaration | ts.ClassExpression,
  funcByName: Map<string, number>,
  className: string,
  structTypeIdx: number,
  fields: FieldDef[],
): void {
  // Compile constructor
  const ctor = decl.members.find(ts.isConstructorDeclaration) as ts.ConstructorDeclaration | undefined;
  const ctorName = `${className}_new`;
  const ctorLocalIdx = funcByName.get(ctorName);
  if (ctorLocalIdx !== undefined) {
    const func = ctx.mod.functions[ctorLocalIdx]!;
    const params: { name: string; type: ValType }[] = [];
    // (#1833) Match the synthetic forwarder params added during pre-registration.
    const implicitBuiltinParent = !ctor ? ctx.classBuiltinParentMap.get(className) : undefined;
    const implicitForwarderArity = implicitBuiltinParent
      ? getImplicitExternrefForwarderArity(ctx, decl, className, implicitBuiltinParent)
      : 0;
    for (let i = 0; i < implicitForwarderArity; i++) {
      params.push({ name: `__arg${i}`, type: { kind: "externref" } });
    }
    // #2082: bind the forwarded ancestor-ctor params as named locals so the
    // replayed parent `this.x = name` assignments below resolve `name`. Must
    // mirror the func-type registration (the implicitStructCtorParams block).
    const implicitStructCtorParams =
      !ctor && !implicitBuiltinParent ? findNearestAncestorCtorParams(ctx, className) : undefined;
    if (implicitStructCtorParams) {
      for (let pi = 0; pi < implicitStructCtorParams.length; pi++) {
        const param = implicitStructCtorParams[pi]!;
        const paramName = ts.isIdentifier(param.name) ? param.name.text : `__param${pi}`;
        const paramType = ctx.checker.getTypeAtLocation(param);
        let wasmType = resolveWasmType(ctx, paramType);
        if (param.initializer && wasmType.kind === "ref") {
          wasmType = { kind: "ref_null", typeIdx: (wasmType as { kind: "ref"; typeIdx: number }).typeIdx };
        }
        params.push({ name: paramName, type: wasmType });
      }
    }
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
    const isExternrefBacked = ctx.classExternrefBackedSet.has(className);

    const fctx: FunctionContext = {
      name: ctorName,
      params,
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

    // Re-resolve the constructor function type now that all class struct types
    // are registered. Constructor parameter types that reference forward-declared
    // classes may have resolved to externref during the collection phase.
    {
      const resolvedParams = params.map((p) => p.type);
      const resolvedResults: ValType[] = isExternrefBacked
        ? [{ kind: "externref" }]
        : [{ kind: "ref", typeIdx: structTypeIdx }];
      const updatedTypeIdx = addFuncType(ctx, resolvedParams, resolvedResults, `${ctorName}_type`);
      if (updatedTypeIdx !== func.typeIdx) {
        func.typeIdx = updatedTypeIdx;
      }
    }

    for (let i = 0; i < params.length; i++) {
      fctx.localMap.set(params[i]!.name, i);
    }

    // Allocate a local for the struct instance (externref for host-backed subclasses)
    const selfLocal = allocLocal(
      fctx,
      "__self",
      isExternrefBacked ? { kind: "externref" } : { kind: "ref", typeIdx: structTypeIdx },
    );

    if (isExternrefBacked) {
      // No struct.new; `__self` starts as null externref and is set by the
      // explicit `super(...)` call (compileSuperCall) or by the implicit
      // super-call we emit below for default-constructor subclasses.
      fctx.body.push({ op: "ref.null.extern" });
      fctx.body.push({ op: "local.set", index: selfLocal });
    } else {
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

    // __proto__ initialization: deferred to #802 (dynamic prototype support)

    // Compile constructor body — `this` maps to __self local
    fctx.localMap.set("this", selfLocal);
    ctx.currentFunc = fctx;

    // Emit default-value initialization for constructor parameters with initializers.
    // For primitive params, __argc distinguishes an omitted argument from a
    // legitimate falsy value. Ref/externref params keep their value checks.
    // #2082: the implicit ctor must also honour the FORWARDED parent params'
    // defaults (`class A { constructor(v = 7){...} }; class B extends A {}` →
    // `new B()` must see v = 7). Those params occupy indices
    // [implicitForwarderArity, implicitForwarderArity + len) — 0-based here
    // since a WasmGC-struct implicit ctor has no externref forwarder prefix.
    const defaultInitParams: ts.NodeArray<ts.ParameterDeclaration> | undefined =
      ctor?.parameters ?? implicitStructCtorParams;
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
        const importName = `__new_${parentName}`;
        const forwardParams = externrefParams(implicitForwarderArity);
        const funcIdx = ensureLateImport(ctx, importName, forwardParams, [{ kind: "externref" }]);
        flushLateImportShifts(ctx, fctx);
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
      }
    }

    // When a child class has no explicit constructor, run inherited field
    // initializers from the parent chain (implicit super() semantics).
    // This must happen before own field initializers.
    if (!ctor && !isExternrefBacked) {
      const parentClassName = ctx.classParentMap.get(className);
      if (parentClassName) {
        // Walk the parent chain (grandparent first) and compile field initializers
        // Guard against circular inheritance (e.g., class X extends X)
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
          // Also run constructor body assignments (this.x = ...) from the parent
          const ancCtor = ancDecl.members.find(ts.isConstructorDeclaration) as ts.ConstructorDeclaration | undefined;
          if (ancCtor?.body) {
            for (const stmt of ancCtor.body.statements) {
              if (
                ts.isExpressionStatement(stmt) &&
                ts.isCallExpression(stmt.expression) &&
                stmt.expression.expression.kind === ts.SyntaxKind.SuperKeyword
              ) {
                continue; // skip super() — already handled by ancestor chain order
              }
              if (
                ts.isExpressionStatement(stmt) &&
                ts.isBinaryExpression(stmt.expression) &&
                stmt.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
                ts.isPropertyAccessExpression(stmt.expression.left) &&
                stmt.expression.left.expression.kind === ts.SyntaxKind.ThisKeyword
              ) {
                const rawName = stmt.expression.left.name.text;
                const fieldName = ts.isPrivateIdentifier(stmt.expression.left.name)
                  ? "__priv_" + rawName.slice(1)
                  : rawName;
                const fieldIdx = fields.findIndex((f) => f.name === fieldName);
                if (fieldIdx !== -1) {
                  fctx.body.push({ op: "local.get", index: selfLocal });
                  compileExpression(ctx, fctx, stmt.expression.right, fields[fieldIdx]!.type);
                  fctx.body.push({ op: "struct.set", typeIdx: structTypeIdx, fieldIdx });
                }
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
      // (#1682) Throw a real ReferenceError instance (not a bare string) so
      // `e instanceof ReferenceError` holds for the caller. emitThrowReferenceError
      // constructs via __new_ReferenceError and degrades to a string throw only
      // when the constructor import is unavailable.
      emitThrowReferenceError(
        ctx,
        fctx,
        "Must call super constructor in derived class before accessing 'this' or returning from derived constructor",
      );
    } else if (ctor?.body) {
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
    if (isExternrefBacked) {
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

    // Return the struct instance
    fctx.body.push({ op: "local.get", index: selfLocal });

    cacheStringLiterals(ctx, fctx);
    deduplicateLocals(fctx);
    func.locals = fctx.locals;
    func.body = fctx.body;
    ctx.currentFunc = null;
  }

  // Compile methods (instance and static)
  // Track which methods have been compiled to avoid overwriting when
  // both static and instance methods share the same name.
  const compiledMethods = new Set<string>();
  for (const member of decl.members) {
    if (ts.isMethodDeclaration(member) && member.name) {
      const methodName = resolveClassMemberName(ctx, member.name);
      if (methodName === undefined) continue; // dynamic computed name — skip
      const fullName = `${className}_${methodName}`;
      if (compiledMethods.has(fullName)) continue; // already compiled
      compiledMethods.add(fullName);
      const isStatic = ctx.staticMethodSet.has(fullName);
      const methodLocalIdx = funcByName.get(fullName);
      if (methodLocalIdx === undefined) continue;

      const func = ctx.mod.functions[methodLocalIdx]!;
      const sig = ctx.checker.getSignatureFromDeclaration(member);
      const retType = sig ? ctx.checker.getReturnTypeOfSignature(sig) : undefined;

      // Static methods have no self param; instance methods get self as first param
      const params: { name: string; type: ValType }[] = isStatic
        ? []
        : [{ name: "this", type: { kind: "ref", typeIdx: structTypeIdx } }];
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
        let wasmType = bindingPatternNeedsWiden ? ({ kind: "externref" } as ValType) : resolveWasmType(ctx, paramType);
        // Widen ref to ref_null for params with defaults or optional params
        // (caller passes ref.null as sentinel). Must match collection phase (#702)
        if ((param.initializer || param.questionToken) && wasmType.kind === "ref") {
          wasmType = { kind: "ref_null", typeIdx: (wasmType as { kind: "ref"; typeIdx: number }).typeIdx };
        }
        params.push({ name: paramName, type: wasmType });
      }

      const isGeneratorMethod = member.asteriskToken !== undefined;
      const isAsyncMethod = member.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ?? false;

      const fctx: FunctionContext = {
        name: fullName,
        params,
        locals: [],
        localMap: new Map(),
        returnType: isGeneratorMethod
          ? { kind: "externref" }
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
          let methDfltType: ValType | null;
          try {
            methDfltType = compileExpression(ctx, fctx, param.initializer, paramType);
          } finally {
            if (isArrayPatternExternref) {
              (ctx as unknown as { _arrayLiteralForceVec?: boolean })._arrayLiteralForceVec = prevForceVec;
            }
          }
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
      if (member.body && bodyUsesArguments(member.body)) {
        const methodParamTypes = params.slice(isStatic ? 0 : 1).map((p) => p.type);
        const paramOffset = isStatic ? 0 : 1; // skip 'this' param for instance methods
        // Class bodies are always strict code → unmapped arguments (#779e).
        emitArgumentsObject(ctx, fctx, methodParamTypes, paramOffset, true);
      }

      if (isGeneratorMethod && member.body) {
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
            ? [{ op: "call", funcIdx: getCaughtIdx } as Instr, { op: "local.set", index: pendingThrowLocal }]
            : [];
        fctx.body.push({
          op: "try",
          blockType: { kind: "empty" },
          body: [{ op: "block", blockType: { kind: "empty" }, body: bodyInstrs }],
          catches: [{ tagIdx, body: catchBody }],
          catchAll: catchAllBody.length > 0 ? catchAllBody : undefined,
        });

        // Return __create_generator or __create_async_generator depending on async flag
        const createGenName = isAsyncMethod ? "__create_async_generator" : "__create_generator";
        const createGenIdx = ctx.funcMap.get(createGenName)!;
        fctx.body.push({ op: "local.get", index: bufferLocal });
        fctx.body.push({ op: "local.get", index: pendingThrowLocal });
        fctx.body.push({ op: "call", funcIdx: createGenIdx });
      } else if (member.body) {
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
      const propName = resolveClassMemberName(ctx, member.name);
      if (propName === undefined) continue; // dynamic computed name — skip
      const getterName = `${className}_get_${propName}`;
      if (compiledAccessors.has(getterName)) continue; // already compiled
      compiledAccessors.add(getterName);
      const getterLocalIdx = funcByName.get(getterName);
      if (getterLocalIdx === undefined) continue;

      const func = ctx.mod.functions[getterLocalIdx]!;
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
      const propName = resolveClassMemberName(ctx, member.name);
      if (propName === undefined) continue; // dynamic computed name — skip
      const setterName = `${className}_set_${propName}`;
      if (compiledAccessors.has(setterName)) continue; // already compiled
      compiledAccessors.add(setterName);
      const setterLocalIdx = funcByName.get(setterName);
      if (setterLocalIdx === undefined) continue;

      const func = ctx.mod.functions[setterLocalIdx]!;

      // First param is self, remaining are the setter parameters
      const params: { name: string; type: ValType }[] = [
        { name: "this", type: { kind: "ref", typeIdx: structTypeIdx } },
      ];
      for (let pi = 0; pi < member.parameters.length; pi++) {
        const param = member.parameters[pi]!;
        const paramName = ts.isIdentifier(param.name) ? param.name.text : `__param${pi}`;
        const paramType = ctx.checker.getTypeAtLocation(param);
        let wasmType = resolveWasmType(ctx, paramType);
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
    const hasSpread = args.some((a) => ts.isSpreadElement(a));
    const importName = `__new_${builtinParent}`;
    const forwardArity = getBuiltinConstructorForwardArity(ctx, builtinParent);
    const forwardParams = externrefParams(forwardArity);
    const funcIdx = ensureLateImport(ctx, importName, forwardParams, [{ kind: "externref" }]);
    flushLateImportShifts(ctx, fctx);
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
    return;
  }

  const parentFields = ctx.structFields.get(parentClassName) ?? [];
  const structTypeIdx = ctx.structMap.get(childClassName)!;

  // ECMA-262 §13.3.7.1 SuperCall constructs the superclass first. That
  // construction initializes superclass fields before the derived class runs
  // its own fields, so parent field initializer side effects must occur even
  // when the child declares the same public/private field name.
  const ancestors: string[] = [];
  const visitedAncestors = new Set<string>();
  let ancestor: string | undefined = parentClassName;
  while (ancestor && !visitedAncestors.has(ancestor)) {
    visitedAncestors.add(ancestor);
    ancestors.unshift(ancestor);
    ancestor = ctx.classParentMap.get(ancestor);
  }
  const childFields = ctx.structFields.get(childClassName) ?? [];
  for (const ancestorName of ancestors) {
    const ancestorDecl = ctx.classDeclarationMap.get(ancestorName);
    if (!ancestorDecl) continue;
    for (const member of ancestorDecl.members) {
      if (!ts.isPropertyDeclaration(member) || !member.name || !member.initializer || hasStaticModifier(member)) {
        continue;
      }
      const fieldName = resolveClassMemberName(ctx, member.name);
      if (fieldName === undefined) continue;
      const fieldIdx = childFields.findIndex((f) => f.name === fieldName);
      if (fieldIdx < 0) continue;
      fctx.body.push({ op: "local.get", index: selfLocal });
      compileExpression(ctx, fctx, member.initializer, childFields[fieldIdx]!.type);
      fctx.body.push({ op: "struct.set", typeIdx: structTypeIdx, fieldIdx });
    }
    // #2078 — also replay the ancestor constructor BODY's `this.<field> = <expr>`
    // assignments. Field declarations only cover initialized members (`x = 5`);
    // a base ctor that sets `this.x = 1` in its body would otherwise leave the
    // child's `x` slot at its zero default after an explicit `super()` (the
    // implicit-super path already does this; compileSuperCall did not). Mirrors
    // the implicit-super replay above. super()/argument-positional fields are
    // handled separately below, so skip nested super() statements here.
    const ancestorCtor = ancestorDecl.members.find(ts.isConstructorDeclaration) as
      | ts.ConstructorDeclaration
      | undefined;
    if (ancestorCtor?.body) {
      // Parent-ctor parameter names: assignments whose RHS reads a parameter
      // (`constructor(v){ this.x = v*2 }`) are NOT replayed here — `v` is not
      // bound in the child's super() frame, and the positional super(args)→field
      // mapping below already drives those fields. We only replay
      // parameter-independent body assignments (`this.x = 1`, `this.w = this.x + 3`).
      const paramNames = new Set<string>();
      for (const p of ancestorCtor.parameters) {
        if (ts.isIdentifier(p.name)) paramNames.add(p.name.text);
      }
      const rhsReadsParam = (expr: ts.Expression): boolean => {
        let found = false;
        const visit = (n: ts.Node): void => {
          if (found) return;
          // A bare identifier that names a parameter (but not a `this.<param>`
          // property access — that's a field, fine to replay).
          if (ts.isIdentifier(n) && paramNames.has(n.text)) {
            const parent = n.parent;
            const isPropName = parent && ts.isPropertyAccessExpression(parent) && parent.name === n;
            if (!isPropName) found = true;
            return;
          }
          ts.forEachChild(n, visit);
        };
        visit(expr);
        return found;
      };
      for (const stmt of ancestorCtor.body.statements) {
        if (
          ts.isExpressionStatement(stmt) &&
          ts.isCallExpression(stmt.expression) &&
          stmt.expression.expression.kind === ts.SyntaxKind.SuperKeyword
        ) {
          continue; // handled by ancestor chain order
        }
        if (
          ts.isExpressionStatement(stmt) &&
          ts.isBinaryExpression(stmt.expression) &&
          stmt.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ts.isPropertyAccessExpression(stmt.expression.left) &&
          stmt.expression.left.expression.kind === ts.SyntaxKind.ThisKeyword
        ) {
          if (rhsReadsParam(stmt.expression.right)) continue;
          const rawName = stmt.expression.left.name.text;
          const bodyFieldName = ts.isPrivateIdentifier(stmt.expression.left.name)
            ? "__priv_" + rawName.slice(1)
            : rawName;
          const bodyFieldIdx = childFields.findIndex((f) => f.name === bodyFieldName);
          if (bodyFieldIdx !== -1) {
            fctx.body.push({ op: "local.get", index: selfLocal });
            compileExpression(ctx, fctx, stmt.expression.right, childFields[bodyFieldIdx]!.type);
            fctx.body.push({ op: "struct.set", typeIdx: structTypeIdx, fieldIdx: bodyFieldIdx });
          }
        }
      }
    }
  }

  // Evaluate super(args) and assign to parent fields on the child struct.
  // Skip __tag (immutable, already set by struct.new) and map arguments to
  // the remaining parent fields in order.
  const assignableParentFields = parentFields
    .map((f, idx) => ({ field: f, fieldIdx: idx }))
    .filter((e) => e.field.name !== "__tag");

  // Check if any argument uses spread syntax: super(...args) (#382)
  const hasSuperSpread = callExpr.arguments.some((a) => ts.isSpreadElement(a));

  if (hasSuperSpread) {
    // Handle spread arguments: super(...args) where args is a vec struct { length, data }
    let fieldIdx2 = 0;
    for (const arg of callExpr.arguments) {
      if (ts.isSpreadElement(arg)) {
        const vecType = compileExpression(ctx, fctx, arg.expression);
        if (!vecType || (vecType.kind !== "ref" && vecType.kind !== "ref_null")) continue;
        const vecLocal = allocLocal(fctx, `__super_spread_vec_${fctx.locals.length}`, vecType);
        fctx.body.push({ op: "local.set", index: vecLocal });
        const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecType.typeIdx);
        if (arrTypeIdx < 0) continue;
        const dataLocal = allocLocal(fctx, `__super_spread_data_${fctx.locals.length}`, {
          kind: "ref_null",
          typeIdx: arrTypeIdx,
        });
        fctx.body.push({ op: "local.get", index: vecLocal });
        fctx.body.push({ op: "struct.get", typeIdx: vecType.typeIdx, fieldIdx: 1 });
        fctx.body.push({ op: "local.set", index: dataLocal });
        const arrDefSpread = ctx.mod.types[arrTypeIdx];
        const spreadElemType =
          arrDefSpread && arrDefSpread.kind === "array" ? arrDefSpread.element : { kind: "f64" as const };
        const remaining = assignableParentFields.length - fieldIdx2;
        for (let i = 0; i < remaining; i++) {
          const { fieldIdx } = assignableParentFields[fieldIdx2]!;
          fctx.body.push({ op: "local.get", index: selfLocal });
          fctx.body.push({ op: "local.get", index: dataLocal });
          fctx.body.push({ op: "i32.const", value: i });
          emitBoundsCheckedArrayGet(fctx, arrTypeIdx, spreadElemType);
          fctx.body.push({ op: "struct.set", typeIdx: structTypeIdx, fieldIdx });
          fieldIdx2++;
        }
      } else {
        if (fieldIdx2 < assignableParentFields.length) {
          const { field, fieldIdx } = assignableParentFields[fieldIdx2]!;
          fctx.body.push({ op: "local.get", index: selfLocal });
          compileExpression(ctx, fctx, arg, field.type);
          fctx.body.push({ op: "struct.set", typeIdx: structTypeIdx, fieldIdx });
          fieldIdx2++;
        } else {
          // (#1551) Side-effect-only evaluation for non-spread args after
          // parent fields are exhausted.
          const sideRes = compileExpression(ctx, fctx, arg);
          if (sideRes !== null) {
            fctx.body.push({ op: "drop" });
          }
        }
      }
    }
  } else {
    // (#1551) ArgumentListEvaluation (§13.3.7.1 step 4) must evaluate every
    // argument expression left-to-right, regardless of whether the parent
    // struct has a slot to receive it. Side-effects (and abrupt completions
    // from arg evaluation) must propagate to the user's try/catch around
    // `super(...)`. Args beyond `assignableParentFields.length` are evaluated
    // for side effects only and the produced value is dropped.
    for (let i = 0; i < callExpr.arguments.length; i++) {
      if (i < assignableParentFields.length) {
        const { field, fieldIdx } = assignableParentFields[i]!;
        fctx.body.push({ op: "local.get", index: selfLocal });
        compileExpression(ctx, fctx, callExpr.arguments[i]!, field.type);
        fctx.body.push({ op: "struct.set", typeIdx: structTypeIdx, fieldIdx });
      } else {
        const argResult = compileExpression(ctx, fctx, callExpr.arguments[i]!);
        if (argResult !== null) {
          fctx.body.push({ op: "drop" });
        }
      }
    }
  }
}
