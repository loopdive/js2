// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Declaration collection and compilation — unified AST visitor, class declarations,
 * function bodies, and struct type registration.
 *
 * Extracted from codegen/index.ts (#1013).
 */
import { ts, forEachChild } from "../ts-api.js";
import {
  isBigIntType,
  isBooleanType,
  isHeterogeneousUnion,
  isNumberType,
  isNumberWrapperType,
  isStringType,
  isVoidType,
  mapTsTypeToWasm,
  unwrapPromiseType,
} from "../checker/type-mapper.js";
import type { FieldDef, Instr, StructTypeDef, ValType, WasmFunction } from "../ir/types.js";
import { collectShapes } from "../shape-inference.js";
import { ensureWrapperTypes } from "./any-helpers.js";
import { ASYNC_CPS_ENABLED, analyzeAsyncBody, asyncFnNeedsCps } from "./async-cps.js";
import { asyncFnNeedsHostDrive, asyncGenDrivableUnderCarrier, asyncGenStem } from "./async-frame.js";
import { collectClassDeclaration, compileClassBodies } from "./class-bodies.js";
import {
  collectBindingPatternNames,
  collectReferencedIdentifiers,
  emitCachedFuncClosureAccess,
  functionBodyReferencesThis,
} from "./closures.js";
import { addFunctionOwnLocals } from "./binding-info.js"; // (#2103) memoized own-locals oracle
import { reportError } from "./context/errors.js";
import type { CodegenContext, FunctionContext, OptionalParamInfo } from "./context/types.js";
import { compileFunctionBody, registerInlinableFunction } from "./function-body.js";
import { bodyUsesArguments } from "./helpers/body-uses-arguments.js";
import {
  addArrayIteratorImports,
  addForInImports,
  addGeneratorImports,
  addIteratorImports,
  addStringImports,
  addUnionImports,
  collectEnumDeclarations,
  classifyTypedArrayType,
  ensureStructForType,
  extractConstantDefault,
  FUNCTIONAL_ARRAY_METHODS,
  hasAsyncModifier,
  hasDeclareModifier,
  hasExportModifier,
  isGeneratorFunction,
  KNOWN_CONSTRUCTORS,
  MATH_HOST_METHODS_1ARG,
  MATH_HOST_METHODS_2ARG,
  parseRegExpLiteral,
  resolveIdentifierType,
  resolveWasmType,
  STRING_METHODS,
  unwrapGeneratorYieldType,
} from "./index.js";
import { isStandalonePromiseActive } from "./async-scheduler.js";
import { ensureNativeStringExternBridge, ensureNativeStringHelpers } from "./native-strings.js";
import { emitNativeParseNumber } from "./parse-number-native.js";
import { emitNativeUriDecode, emitNativeUriEncode } from "./uri-encoding-native.js";
import { emitNativeEscape, emitNativeUnescape } from "./escape-native.js";
import { emitNativeNumberFormat } from "./number-format-native.js";
import {
  isNativeGeneratorCandidate,
  registerNativeGenerator,
  sourceNeedsGeneratorHostImports,
} from "./generators-native.js";
import { emitWasiErrorConstructor, isWasiErrorName } from "./registry/error-types.js";
import { addImport, addStringConstantGlobal, localGlobalIdx, nextModuleGlobalIdx } from "./registry/imports.js";
import {
  addFuncType,
  getArrTypeIdxFromVec,
  getOrRegisterTemplateVecType,
  getOrRegisterVecType,
} from "./registry/types.js";
import { computeElidableTopLevelTdzNames } from "./expressions/identifiers.js";
import { isArrayProtoIteratorAssignTarget } from "./expressions/proto-override.js";
import { isFnctorPrototypeAssignTarget } from "./expressions/fnctor-prototype.js";
import { compileExpression, compileStatement } from "./shared.js";
import { expandLinearU8ParamTypes } from "./linear-uint8-signatures.js";
import { definedFuncAt } from "./func-space.js"; // (#1916 S2) positional-read chokepoint
import { inferStandaloneRegExpMatchGlobalType } from "./regexp-standalone.js";

// ── Extracted subsystems (#3268) — re-exported for external consumers ─────
export {
  createUnifiedCollectorState,
  finalizeUnifiedCollector,
  unifiedVisitNode,
} from "./declarations/import-collector.js";
export {
  applyShapeInference,
  collectEmptyObjectWidening,
  collectGrowableObjectLiterals,
} from "./declarations/object-shape-widening.js";
export { inferNumericReturnTypes } from "./declarations/param-return-inference.js";
// Import-back: symbols the declaration trunk still calls internally.
import {
  inferParamTypeFromBody,
  inferParamTypeFromCallSites,
  resolveGenericCallSiteTypes,
} from "./declarations/param-return-inference.js";
import {
  collectInterface,
  collectObjectType,
  resolveStructFieldTypes,
} from "./declarations/struct-type-registration.js";
/**
 * (#1700) Record TypedArray classifications for a user-exported function so
 * the JS-host `wrapExports` can marshal `Uint8Array` params/returns across
 * the JS↔Wasm boundary. The Wasm signature alone is ambiguous —
 * `(input: Uint8Array)` and `(input: number[])` lower to the same
 * `(ref null $Vec[f64])` — so we surface the TS-level distinction here.
 *
 * No-op when every slot classifies as `"other"` so non-TypedArray modules
 * accumulate no metadata.
 */
function recordExportSignature(
  ctx: CodegenContext,
  exportName: string,
  stmt: ts.FunctionDeclaration,
  isAsync: boolean,
): void {
  const sig = ctx.checker.getSignatureFromDeclaration(stmt);
  if (!sig) return;
  const params: import("../ir/types.js").TypedArrayKind[] = [];
  let anyHit = false;
  for (const p of stmt.parameters) {
    const pt = ctx.checker.getTypeAtLocation(p);
    const kind = classifyTypedArrayType(pt, ctx.checker);
    if (kind !== "other") anyHit = true;
    params.push(kind);
  }
  const retType = ctx.checker.getReturnTypeOfSignature(sig);
  const unwrappedRet = isAsync ? unwrapPromiseType(retType, ctx.checker) : retType;
  const result = classifyTypedArrayType(unwrappedRet, ctx.checker);
  if (result !== "other") anyHit = true;
  if (!anyHit) return;
  ctx.exportSignatures.set(exportName, { params, result });
}

// An unannotated binding-pattern parameter — `function f([x, y])` or
// `function f({a, b})` — must route through the externref destructure path
// so that the iterator protocol drives element extraction (spec
// §13.3.3.6 IteratorBindingInitialization). Without this widening the
// param compiles to a tuple struct signature and `f(generator)` silently
// skips the iterator's `.next()`. Mirrors closures.ts:905 for arrows /
// function-expressions. Skip when the user wrote an explicit type
// annotation — they asked for the tuple-struct specialization. (#862)
function bindingPatternParamNeedsWiden(p: ts.ParameterDeclaration): boolean {
  if (p.type || p.dotDotDotToken) return false;
  return ts.isArrayBindingPattern(p.name) || ts.isObjectBindingPattern(p.name);
}

// A binding-pattern parameter with a rest element and no type annotation
// (e.g. `function f([...r])` or `function f({...x})`) infers as `{}` or
// `{ [k: string]: any }` in TypeScript, which resolveWasmType maps to a
// degenerate struct (single-field cell or empty struct). Callers that
// pass an array/object to such a param fail the ref.test cast and
// receive ref.null — breaking destructuring inside the function. Force
// externref so the conversion paths in destructureParam{Array,Object}
// handle the incoming value correctly.
function restBindingOverridesToExternref(p: ts.ParameterDeclaration): boolean {
  if (p.type || p.dotDotDotToken) return false;
  if (ts.isArrayBindingPattern(p.name)) {
    return p.name.elements.some((e) => !ts.isOmittedExpression(e) && !!e.dotDotDotToken);
  }
  if (ts.isObjectBindingPattern(p.name)) {
    return p.name.elements.some((e) => !!e.dotDotDotToken);
  }
  return false;
}

/**
 * (#3268) Lower a single non-rest function parameter to its Wasm ValType.
 * Consolidates the four byte-identical per-parameter lowering blocks
 * (registerBodyless + collectDeclarations, generator and normal arms):
 *   1. binding-pattern / rest-binding widen to externref,
 *   2. default-valued non-null ref → ref_null (caller passes ref.null = "use default"),
 *   3. implicit-`any` param → infer a concrete type from call sites, else body usage (#1121).
 */
function lowerParamType(
  ctx: CodegenContext,
  param: ts.ParameterDeclaration,
  funcName: string,
  index: number,
  stmt: ts.FunctionDeclaration,
  sourceFile: ts.SourceFile,
): ValType {
  const paramType = ctx.checker.getTypeAtLocation(param);
  let wasmType: ValType = bindingPatternParamNeedsWiden(param)
    ? { kind: "externref" }
    : restBindingOverridesToExternref(param)
      ? { kind: "externref" }
      : resolveWasmType(ctx, paramType);
  // If the parameter has a default value and is a non-null ref type, widen to
  // ref_null so callers can pass ref.null as a sentinel for "use default".
  if (param.initializer && wasmType.kind === "ref") {
    wasmType = { kind: "ref_null", typeIdx: wasmType.typeIdx };
  }
  // If the parameter has no explicit type annotation and resolved to externref
  // (from `any`), try to infer a concrete type from call sites, then body usage.
  if (
    !param.type &&
    paramType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown) &&
    (wasmType.kind === "externref" ||
      (wasmType.kind === "ref_null" && ctx.anyValueTypeIdx >= 0 && wasmType.typeIdx === ctx.anyValueTypeIdx))
  ) {
    let inferred = inferParamTypeFromCallSites(ctx, funcName, index, sourceFile);
    if (!inferred) inferred = inferParamTypeFromBody(ctx, stmt, index);
    if (inferred) wasmType = inferred;
  }
  return wasmType;
}

function containingFunctionOrSource(node: ts.Node): ts.Node | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (
      ts.isSourceFile(current) ||
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current) ||
      ts.isMethodDeclaration(current) ||
      ts.isConstructorDeclaration(current) ||
      ts.isGetAccessorDeclaration(current) ||
      ts.isSetAccessorDeclaration(current)
    ) {
      return current;
    }
    current = current.parent;
  }
  return undefined;
}

function isDescendantOf(node: ts.Node, ancestor: ts.Node): boolean {
  let current: ts.Node | undefined = node;
  while (current) {
    if (current === ancestor) return true;
    current = current.parent;
  }
  return false;
}

function functionDeclarationCapturesEnclosingLocal(ctx: CodegenContext, stmt: ts.FunctionDeclaration): boolean {
  if (!stmt.body) return false;
  const referenced = new Set<string>();
  const ownLocals = new Set<string>();
  addFunctionOwnLocals(stmt, ownLocals); // (#2103) memoized own-locals
  for (const s of stmt.body.statements) {
    collectReferencedIdentifiers(s, referenced, ownLocals);
  }

  for (const name of referenced) {
    if (name === "arguments" || name === "this" || name === "super") continue;
    let capturesOuterFunctionLocal = false;
    const visit = (node: ts.Node): void => {
      if (capturesOuterFunctionLocal) return;
      if (
        node !== stmt &&
        (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node))
      ) {
        return;
      }
      if (ts.isIdentifier(node) && node.text === name) {
        const sym = ctx.checker.getSymbolAtLocation(node);
        const decl = sym?.valueDeclaration ?? sym?.declarations?.[0];
        if (decl && !isDescendantOf(decl, stmt)) {
          const owner = containingFunctionOrSource(decl);
          if (owner && !ts.isSourceFile(owner)) {
            capturesOuterFunctionLocal = true;
            return;
          }
        }
      }
      forEachChild(node, visit);
    };
    visit(stmt.body);
    if (capturesOuterFunctionLocal) return true;
  }
  return false;
}

function registerBodylessFunctionDeclaration(
  ctx: CodegenContext,
  stmt: ts.FunctionDeclaration,
  sourceFile: ts.SourceFile,
): WasmFunction | undefined {
  if (!stmt.name || !stmt.body || hasDeclareModifier(stmt)) return undefined;
  const name = stmt.name.text;
  const sig = ctx.checker.getSignatureFromDeclaration(stmt);
  if (!sig) return undefined;

  ctx.functionNameMap.set(name, name);
  try {
    const sourceText = stmt.getText(sourceFile);
    if (sourceText) ctx.funcSourceText.set(name, sourceText);
  } catch {
    // Synthetic nodes lacking source positions: keep the normal placeholder.
  }

  const isGeneric = stmt.typeParameters && stmt.typeParameters.length > 0;
  const resolved = isGeneric ? resolveGenericCallSiteTypes(ctx, name, sourceFile) : null;
  if (resolved) {
    ctx.genericResolved.set(name, resolved);
  }

  const isAsync = hasAsyncModifier(stmt);
  const isGenerator = isGeneratorFunction(stmt);
  if (isAsync && !isGenerator) {
    ctx.asyncFunctions.add(name);
  }
  if (isGenerator) {
    ctx.generatorFunctions.add(name);
    const retType = ctx.checker.getReturnTypeOfSignature(sig);
    ctx.generatorYieldType.set(name, unwrapGeneratorYieldType(retType, ctx));
  }

  const retType = ctx.checker.getReturnTypeOfSignature(sig);
  const unwrappedRetType = isAsync ? unwrapPromiseType(retType, ctx.checker) : retType;
  if (!isGenerator && !isVoidType(unwrappedRetType)) ensureStructForType(ctx, unwrappedRetType);
  for (const p of stmt.parameters) {
    ensureStructForType(ctx, ctx.checker.getTypeAtLocation(p));
  }

  let params: ValType[];
  let results: ValType[];
  if (isGenerator) {
    params = [];
    for (let i = 0; i < stmt.parameters.length; i++) {
      const param = stmt.parameters[i]!;
      params.push(lowerParamType(ctx, param, name, i, stmt, sourceFile));
    }
    const nativeGenerator = registerNativeGenerator(ctx, stmt, name, params);
    results = nativeGenerator ? [{ kind: "ref", typeIdx: nativeGenerator.stateTypeIdx }] : [{ kind: "externref" }];
  } else if (resolved) {
    params = resolved.params;
    results = resolved.results;
  } else {
    params = [];
    for (let i = 0; i < stmt.parameters.length; i++) {
      const param = stmt.parameters[i]!;
      if (param.dotDotDotToken) {
        const paramType = ctx.checker.getTypeAtLocation(param);
        const typeArgs = ctx.checker.getTypeArguments(paramType as ts.TypeReference);
        const elemTsType = typeArgs[0];
        const elemType: ValType = elemTsType ? resolveWasmType(ctx, elemTsType) : { kind: "f64" };
        const elemKey =
          elemType.kind === "ref" || elemType.kind === "ref_null" ? `ref_${elemType.typeIdx}` : elemType.kind;
        const vecTypeIdx = getOrRegisterVecType(ctx, elemKey, elemType);
        const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
        params.push({ kind: "ref_null", typeIdx: vecTypeIdx });
        ctx.funcRestParams.set(name, {
          restIndex: i,
          elemType,
          arrayTypeIdx: arrTypeIdx,
          vecTypeIdx,
        });
      } else {
        params.push(lowerParamType(ctx, param, name, i, stmt, sourceFile));
      }
    }
    const rUnwrapped = isAsync ? unwrapPromiseType(retType, ctx.checker) : retType;
    const inferredNumericRet = !isAsync ? ctx.numericReturnTypes?.get(name) : undefined;
    const isImplicitAnyReturn = (rUnwrapped.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
    const allParamsNumeric = params.every((p) => p.kind === "f64" || p.kind === "i32");
    if (inferredNumericRet && isImplicitAnyReturn && allParamsNumeric) {
      results = [inferredNumericRet];
    } else {
      results = isVoidType(rUnwrapped) ? [] : [resolveWasmType(ctx, rUnwrapped)];
    }
  }

  params = expandLinearU8ParamTypes(ctx, stmt, params);

  const optionalParams: OptionalParamInfo[] = [];
  for (let i = 0; i < stmt.parameters.length; i++) {
    const param = stmt.parameters[i]!;
    if (param.questionToken || param.initializer) {
      const info: OptionalParamInfo = { index: i, type: params[i]! };
      if (param.initializer) {
        const cd = extractConstantDefault(param.initializer, params[i]!, ctx);
        if (cd) info.constantDefault = cd;
        else info.hasExpressionDefault = true;
      }
      optionalParams.push(info);
    }
  }
  if (optionalParams.length > 0) {
    ctx.funcOptionalParams.set(name, optionalParams);
  }
  if (bodyUsesArguments(stmt.body)) {
    ctx.funcUsesArguments.add(name);
  }

  const typeIdx = addFuncType(ctx, params, results, `${name}_type`);
  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  const func: WasmFunction = {
    name,
    typeIdx,
    locals: [],
    body: [],
    exported: false,
  };
  ctx.funcMap.set(name, funcIdx);
  ctx.mod.functions.push(func);
  if (!ctx.preRegisteredBodyless) ctx.preRegisteredBodyless = new Set();
  ctx.preRegisteredBodyless.add(name);
  return func;
}

function defaultReturnInstrs(returnType: ValType | undefined): Instr[] {
  if (!returnType) return [];
  switch (returnType.kind) {
    case "f64":
      return [{ op: "f64.const", value: 0 }];
    case "f32":
      return [{ op: "f32.const", value: 0 }];
    case "i32":
      return [{ op: "i32.const", value: 0 }];
    case "i64":
      return [{ op: "i64.const", value: 0n }];
    case "externref":
    case "ref_extern":
      return [{ op: "ref.null.extern" }];
    case "eqref":
    case "anyref":
      return [{ op: "ref.null.eq" }];
    case "funcref":
      return [{ op: "ref.null.func" }];
    case "ref_null":
      return [{ op: "ref.null", typeIdx: returnType.typeIdx }];
    case "ref":
      return [{ op: "ref.null", typeIdx: returnType.typeIdx }, { op: "ref.as_non_null" }];
    default:
      return [{ op: "i32.const", value: 0 }];
  }
}

export function collectDeclarations(ctx: CodegenContext, sourceFile: ts.SourceFile, isEntryFile = true): void {
  function getAssignmentRootIdentifier(expr: ts.Expression): string | undefined {
    let current: ts.Expression = expr;
    while (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isTypeAssertionExpression(current)
    ) {
      current = current.expression;
    }
    while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
      current = current.expression;
      while (
        ts.isParenthesizedExpression(current) ||
        ts.isAsExpression(current) ||
        ts.isNonNullExpression(current) ||
        ts.isTypeAssertionExpression(current)
      ) {
        current = current.expression;
      }
    }
    return ts.isIdentifier(current) ? current.text : undefined;
  }

  // First: collect enum declarations (so enum values are available)
  collectEnumDeclarations(ctx, sourceFile);

  // Second: collect interfaces and type aliases (so struct types are available).
  // Skip declarations from `.d.ts` files: those describe shapes of host
  // values (DOM types, npm package public API). Lowering them to WasmGC
  // structs registers types whose fields can recursively reference array
  // types of other declaration-file interfaces, producing forward heap-type
  // references that fail Wasm validation when the dead-elim pass compacts
  // the type section. (#1287)
  if (!sourceFile.isDeclarationFile) {
    for (const stmt of sourceFile.statements) {
      if (ts.isInterfaceDeclaration(stmt)) {
        collectInterface(ctx, stmt);
      } else if (ts.isTypeAliasDeclaration(stmt)) {
        const aliasType = ctx.checker.getTypeAtLocation(stmt);
        if (aliasType.flags & ts.TypeFlags.Object) {
          collectObjectType(ctx, stmt.name.text, aliasType);
        }
      }
    }
  }

  // Resolve struct field types: now that all interfaces and type aliases are
  // registered, re-resolve any externref fields that should be ref $struct.
  // This fixes ordering issues (e.g. Outer references Inner, regardless of
  // declaration order) and ensures nested destructuring works correctly.
  resolveStructFieldTypes(ctx, sourceFile);

  // Collect class declarations (struct types + constructor/method functions)
  // Also collect class expressions in variable declarations: const C = class { ... }
  // Scan recursively into function bodies to find class expressions defined inside functions
  // Recursively scan an AST node for `new (class { ... })()` patterns
  // and pre-register the anonymous class so struct types are available during codegen
  function registerClassExpression(classExpr: ts.ClassExpression, nameHint?: string): void {
    if (ctx.anonClassExprNames.has(classExpr)) return;
    // Generate a synthetic name and pre-register the class
    // For named class expressions (class C { ... }), use the name to avoid
    // collisions; for anonymous ones, generate a counter-based name.
    const syntheticName = nameHint
      ? `__anonClass_${nameHint}_${ctx.anonTypeCounter++}`
      : classExpr.name
        ? `__anonClass_${classExpr.name.text}_${ctx.anonTypeCounter++}`
        : `__anonClass_${ctx.anonTypeCounter++}`;
    // Store a mapping from the AST node to the synthetic name so codegen can find it
    ctx.anonClassExprNames.set(classExpr, syntheticName);
    collectClassDeclaration(ctx, classExpr, syntheticName);
  }

  function collectAnonymousClassesInNewExpr(node: ts.Node): void {
    if (ts.isNewExpression(node)) {
      let inner: ts.Expression = node.expression;
      while (ts.isParenthesizedExpression(inner)) {
        inner = inner.expression;
      }
      if (ts.isClassExpression(inner)) {
        registerClassExpression(inner);
      }
    }
    // Class expression in assignment RHS: x = class { ... }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      let rhs: ts.Expression = node.right;
      while (ts.isParenthesizedExpression(rhs)) {
        rhs = rhs.expression;
      }
      if (ts.isClassExpression(rhs)) {
        // Use the LHS identifier as the name hint if available
        const nameHint = ts.isIdentifier(node.left) ? node.left.text : undefined;
        registerClassExpression(rhs, nameHint);
        // Also map the LHS identifier to the synthetic name so `new C()` resolves
        if (nameHint) {
          const syntheticName = ctx.anonClassExprNames.get(rhs);
          if (syntheticName) {
            ctx.classExprNameMap.set(nameHint, syntheticName);
          }
        }
      }
    }
    // Standalone class expression in any other position
    if (ts.isClassExpression(node)) {
      registerClassExpression(node);
    }
    forEachChild(node, collectAnonymousClassesInNewExpr);
  }

  function collectClassesFromStatements(stmts: ts.NodeArray<ts.Statement> | readonly ts.Statement[]): void {
    for (const stmt of stmts) {
      // `class X` in a `.d.ts` file is implicitly ambient — only the type
      // declaration is real, there is no JS body to compile. Treating it as
      // a user-defined class registers a WasmGC struct type whose field
      // resolution can produce forward heap-type references (e.g.
      // `children: X[]` → struct ref array ref struct loop) that fail Wasm
      // validation. The extern collection pass (`collectExternClass` /
      // `collectExternFromDeclareVar` in `index.ts`) owns the type-only
      // registration for these shapes. (#1287)
      const isAmbient = hasDeclareModifier(stmt) || stmt.getSourceFile().isDeclarationFile;
      if (ts.isClassDeclaration(stmt) && stmt.name && !isAmbient) {
        collectClassDeclaration(ctx, stmt);
        // Register class declaration .name
        ctx.functionNameMap.set(stmt.name.text, stmt.name.text);
      } else if (ts.isVariableStatement(stmt) && !isAmbient) {
        for (const decl of stmt.declarationList.declarations) {
          if (ts.isIdentifier(decl.name) && decl.initializer && ts.isClassExpression(decl.initializer)) {
            collectClassDeclaration(ctx, decl.initializer, decl.name.text);
            // Register class expression .name: named class keeps its own name, anonymous gets variable name
            const esName = decl.initializer.name ? decl.initializer.name.text : decl.name.text;
            ctx.functionNameMap.set(decl.name.text, esName);
          }
          // Recurse into arrow functions and function expressions
          if (decl.initializer) {
            collectClassesFromFunctionBody(decl.initializer);
          }
        }
      } else if (ts.isFunctionDeclaration(stmt) && stmt.body) {
        collectClassesFromStatements(stmt.body.statements);
      } else if (ts.isIfStatement(stmt)) {
        // Recurse into if/else blocks
        if (ts.isBlock(stmt.thenStatement)) {
          collectClassesFromStatements(stmt.thenStatement.statements);
        }
        if (stmt.elseStatement && ts.isBlock(stmt.elseStatement)) {
          collectClassesFromStatements(stmt.elseStatement.statements);
        }
      } else if (ts.isBlock(stmt)) {
        collectClassesFromStatements(stmt.statements);
      } else if (
        ts.isForStatement(stmt) ||
        ts.isForInStatement(stmt) ||
        ts.isForOfStatement(stmt) ||
        ts.isWhileStatement(stmt) ||
        ts.isDoStatement(stmt)
      ) {
        const body = stmt.statement;
        if (ts.isBlock(body)) {
          collectClassesFromStatements(body.statements);
        }
      } else if (ts.isSwitchStatement(stmt)) {
        for (const clause of stmt.caseBlock.clauses) {
          collectClassesFromStatements(clause.statements);
        }
      } else if (ts.isTryStatement(stmt)) {
        collectClassesFromStatements(stmt.tryBlock.statements);
        if (stmt.catchClause) {
          collectClassesFromStatements(stmt.catchClause.block.statements);
        }
        if (stmt.finallyBlock) {
          collectClassesFromStatements(stmt.finallyBlock.statements);
        }
      } else if (ts.isLabeledStatement(stmt)) {
        if (ts.isBlock(stmt.statement)) {
          collectClassesFromStatements(stmt.statement.statements);
        }
      } else if (ts.isExportAssignment(stmt) || ts.isExportDeclaration(stmt)) {
        // handled at top level
      }
      // Also scan all statements for new (class { ... })() patterns
      collectAnonymousClassesInNewExpr(stmt);

      // (#1394 dual-registration bridge) `var C = class { ... }` triggers TWO
      // class registrations against the SAME ClassExpression node:
      //   1. The var-statement branch above registers it under `decl.name.text`
      //      (e.g. "C") via collectClassDeclaration.
      //   2. collectAnonymousClassesInNewExpr (just above) recurses into the
      //      stmt, finds the class expression, and via registerClassExpression
      //      registers it AGAIN under a synthetic `__anonClass_N` name.
      //
      // The instance-type path (TS resolves `c: C` → symbol "__class" →
      // classExprNameMap["__class"] → "__anonClass_N") and the call-site
      // path both end up using the synthetic name. The proto-handler in
      // property-access.ts, however, key-resolves off the user-visible
      // identifier "C" and was returning `classExprNameMap.get("C") ?? "C"`
      // which fell through to "C" because no map entry existed for the
      // var-name.
      //
      // Result: `c.m` cached under `${synthetic}_m`, `C.prototype.m` cached
      // under `C_m`, `c.m === C.prototype.m` failed (~556 class/elements
      // verifyProperty regressions). Bridge by mapping the var-name to the
      // synthetic name AFTER both registrations have run, so every access
      // path collapses to the same cache key.
      if (ts.isVariableStatement(stmt) && !isAmbient) {
        for (const decl of stmt.declarationList.declarations) {
          if (ts.isIdentifier(decl.name) && decl.initializer && ts.isClassExpression(decl.initializer)) {
            const syntheticName = ctx.anonClassExprNames.get(decl.initializer);
            if (syntheticName && !ctx.classExprNameMap.has(decl.name.text)) {
              ctx.classExprNameMap.set(decl.name.text, syntheticName);
            }
          }
        }
      }
    }
  }

  /** Recurse into arrow functions and function expressions to find class declarations */
  function collectClassesFromFunctionBody(expr: ts.Expression): void {
    if (ts.isArrowFunction(expr)) {
      if (ts.isBlock(expr.body)) {
        collectClassesFromStatements(expr.body.statements);
      }
    } else if (ts.isFunctionExpression(expr)) {
      if (expr.body) {
        collectClassesFromStatements(expr.body.statements);
      }
      // Also scan all statements for new (class { ... })() patterns
      collectAnonymousClassesInNewExpr(expr);
    }
  }
  collectClassesFromStatements(sourceFile.statements);

  // Third: collect function declarations (uses resolveWasmType for real type indices)
  for (const stmt of sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt) && (stmt.name || hasExportModifier(stmt))) {
      // Skip declare function stubs (no body, inside or matching declare)
      if (hasDeclareModifier(stmt)) continue;

      // Anonymous `export default function() {}` gets the synthetic name "default"
      const name = stmt.name ? stmt.name.text : "default";
      // Register the function's .name value for ES-spec compliance
      ctx.functionNameMap.set(name, name);
      // (#1983) Record the top-level user-function name so class-member funcMap
      // keys (`${className}_${member}`) that would collide with it can relocate.
      // Only real `function` declarations participate — class names are tracked
      // separately and must NOT poison the collision set.
      if (stmt.name) ctx.topLevelFunctionNames.add(name);
      // #1463 — capture source text for Function.prototype.toString() so that
      // `someFn.toString()` returns the original declaration text instead of
      // the `function () { [native code] }` placeholder. Only top-level
      // declarations are captured; class methods, arrow functions, and
      // function expressions fall back to the placeholder.
      try {
        const sourceText = stmt.getText(sourceFile);
        if (sourceText) ctx.funcSourceText.set(name, sourceText);
      } catch {
        // Synthetic nodes lacking source positions — skip silently.
      }
      const sig = ctx.checker.getSignatureFromDeclaration(stmt);
      if (!sig) continue;

      // Check if this is a generic function — resolve types from call site
      const isGeneric = stmt.typeParameters && stmt.typeParameters.length > 0;
      const resolved = isGeneric ? resolveGenericCallSiteTypes(ctx, name, sourceFile) : null;
      if (resolved) {
        ctx.genericResolved.set(name, resolved);
      }

      // Track async functions — unwrap Promise<T> for Wasm return type
      // Exclude async generators: they return AsyncGenerator objects, not Promises.
      const isAsync = hasAsyncModifier(stmt);
      const isGenerator = isGeneratorFunction(stmt);
      if (isAsync && !isGenerator) {
        ctx.asyncFunctions.add(name);
      }

      // Track generator functions (function*)
      if (isGenerator) {
        ctx.generatorFunctions.add(name);
        // Determine yield element type from Generator<T> return annotation
        const retType = ctx.checker.getReturnTypeOfSignature(sig);
        const yieldType = unwrapGeneratorYieldType(retType, ctx);
        ctx.generatorYieldType.set(name, yieldType);
      }

      // Ensure anonymous types in signature are registered as structs
      const retType = ctx.checker.getReturnTypeOfSignature(sig);
      // For async functions, unwrap Promise<T> to get T for struct registration
      const unwrappedRetType = isAsync ? unwrapPromiseType(retType, ctx.checker) : retType;
      if (!isGenerator && !isVoidType(unwrappedRetType)) ensureStructForType(ctx, unwrappedRetType);
      for (const p of stmt.parameters) {
        const pt = ctx.checker.getTypeAtLocation(p);
        ensureStructForType(ctx, pt);
      }

      let params: ValType[];
      let results: ValType[];

      if (isGenerator) {
        // Generator functions: parameters are compiled normally, return is externref
        params = [];
        for (let i = 0; i < stmt.parameters.length; i++) {
          const param = stmt.parameters[i]!;
          params.push(lowerParamType(ctx, param, name, i, stmt, sourceFile));
        }
        const nativeGenerator = registerNativeGenerator(ctx, stmt, name, params);
        results = nativeGenerator ? [{ kind: "ref", typeIdx: nativeGenerator.stateTypeIdx }] : [{ kind: "externref" }]; // JS-host fallback returns a Generator object
      } else if (resolved) {
        // Use call-site resolved types for generic functions
        params = resolved.params;
        results = resolved.results;
      } else {
        params = [];
        for (let i = 0; i < stmt.parameters.length; i++) {
          const param = stmt.parameters[i]!;
          if (param.dotDotDotToken) {
            // Rest parameter: ...args: T[] → single (ref $__vec_elemKind) param
            const paramType = ctx.checker.getTypeAtLocation(param);
            const typeArgs = ctx.checker.getTypeArguments(paramType as ts.TypeReference);
            const elemTsType = typeArgs[0];
            const elemType: ValType = elemTsType ? resolveWasmType(ctx, elemTsType) : { kind: "f64" };
            // Use a unique key for ref element types so each struct gets its own array type
            const elemKey =
              elemType.kind === "ref" || elemType.kind === "ref_null" ? `ref_${elemType.typeIdx}` : elemType.kind;
            const vecTypeIdx = getOrRegisterVecType(ctx, elemKey, elemType);
            const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
            params.push({ kind: "ref_null", typeIdx: vecTypeIdx });
            ctx.funcRestParams.set(name, {
              restIndex: i,
              elemType,
              arrayTypeIdx: arrTypeIdx,
              vecTypeIdx,
            });
          } else {
            params.push(lowerParamType(ctx, param, name, i, stmt, sourceFile));
          }
        }
        const r = ctx.checker.getReturnTypeOfSignature(sig);
        // For async functions, unwrap Promise<T> to get T for Wasm return type
        const rUnwrapped = isAsync ? unwrapPromiseType(r, ctx.checker) : r;
        // #1121: Override TS's implicit-any return with our inferred numeric
        // return type if every param is numeric and the body is a pure
        // numeric kernel (catches e.g. recursive `function fib(n) {...}`).
        const inferredNumericRet = !isAsync ? ctx.numericReturnTypes?.get(name) : undefined;
        const isImplicitAnyReturn = (rUnwrapped.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
        const allParamsNumeric = params.every((p) => p.kind === "f64" || p.kind === "i32");
        if (inferredNumericRet && isImplicitAnyReturn && allParamsNumeric) {
          results = [inferredNumericRet];
        } else {
          results = isVoidType(rUnwrapped) ? [] : [resolveWasmType(ctx, rUnwrapped)];
        }
      }

      params = expandLinearU8ParamTypes(ctx, stmt, params);

      const optionalParams: OptionalParamInfo[] = [];
      for (let i = 0; i < stmt.parameters.length; i++) {
        const param = stmt.parameters[i]!;
        if (param.questionToken || param.initializer) {
          const info: OptionalParamInfo = { index: i, type: params[i]! };
          if (param.initializer) {
            const cd = extractConstantDefault(param.initializer, params[i]!, ctx);
            if (cd) {
              info.constantDefault = cd;
            } else {
              info.hasExpressionDefault = true;
            }
          }
          optionalParams.push(info);
        }
      }

      if (optionalParams.length > 0) {
        ctx.funcOptionalParams.set(name, optionalParams);
      }

      // Track functions that read `arguments` (#1053) so callers can
      // populate the __extras_argv global with runtime args beyond the
      // formal param count.
      if (stmt.body && bodyUsesArguments(stmt.body)) {
        ctx.funcUsesArguments.add(name);
      }

      const typeIdx = addFuncType(ctx, params, results, `${name}_type`);
      const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
      ctx.funcMap.set(name, funcIdx);

      // Create placeholder function to be filled in second pass
      // Only export as Wasm exports if this is the entry file
      const isExported = isEntryFile && hasExportModifier(stmt);
      const func: WasmFunction = {
        name,
        typeIdx,
        locals: [],
        body: [],
        exported: isExported,
      };
      ctx.mod.functions.push(func);

      if (isExported) {
        ctx.mod.exports.push({
          name,
          desc: { kind: "func", index: funcIdx },
        });
        recordExportSignature(ctx, name, stmt, isAsync);
        // `export default function foo() {}` — also export as "default" (#1074)
        // Skip if name is already "default" (anonymous export default function)
        const mods = ts.canHaveModifiers(stmt) ? ts.getModifiers(stmt) : undefined;
        const isDefault = mods?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword) ?? false;
        if (isDefault && name !== "default") {
          ctx.mod.exports.push({
            name: "default",
            desc: { kind: "func", index: funcIdx },
          });
          recordExportSignature(ctx, "default", stmt, isAsync);
        }
      }
    }
  }

  // Export default: surface `export default <ident>` as Wasm exports (#1074).
  // Walk ExportAssignment nodes and resolve the bound declaration to a function
  // already registered in funcMap.  Emit under both the declaration name AND
  // "default" so either `instance.exports.identity(x)` or
  // `instance.exports.default(x)` works from a JS host.
  if (isEntryFile) {
    for (const stmt of sourceFile.statements) {
      if (!ts.isExportAssignment(stmt)) continue;
      // `export = expr` (isExportEquals) is CJS — skip for now (#1075)
      if (stmt.isExportEquals) continue;

      let targetName: string | undefined;

      // Case 1: `export default <identifier>` — resolve the referenced name
      if (ts.isIdentifier(stmt.expression)) {
        targetName = stmt.expression.text;
      }
      // Case 2: `export default function foo() {}` — inline function decl
      else if (ts.isFunctionExpression(stmt.expression) && stmt.expression.name) {
        targetName = stmt.expression.name.text;
      }

      if (targetName && ctx.funcMap.has(targetName)) {
        const funcIdx = ctx.funcMap.get(targetName)!;

        // Mark the function as exported (for dead-code elimination etc.)
        const func = definedFuncAt(ctx, funcIdx);
        if (func && !func.exported) {
          func.exported = true;
        }

        // Add the declaration name as an export if not already exported
        const alreadyExported = ctx.mod.exports.some((e) => e.desc.kind === "func" && e.desc.index === funcIdx);
        if (!alreadyExported) {
          ctx.mod.exports.push({
            name: targetName,
            desc: { kind: "func", index: funcIdx },
          });
        }

        // Always add "default" alias so ESM semantics are preserved
        ctx.mod.exports.push({
          name: "default",
          desc: { kind: "func", index: funcIdx },
        });
      }
    }
  }

  // ESM named-export declaration: `export { foo, bar as baz };` (#1277).
  // Without this, the rewriter and existing ESM walker only handle
  // `export function foo() {}` and `export default <ident>`. Re-exports
  // from another module (`export { x } from "spec"`) are intentionally
  // skipped here — those need import resolution + re-export wiring that
  // isn't part of this gap.
  if (isEntryFile) {
    for (const stmt of sourceFile.statements) {
      if (!ts.isExportDeclaration(stmt)) continue;
      if (!stmt.exportClause || !ts.isNamedExports(stmt.exportClause)) continue;
      if (stmt.moduleSpecifier) continue; // re-export — handled elsewhere
      for (const spec of stmt.exportClause.elements) {
        // `export { foo as bar }` → propertyName=foo, name=bar
        // `export { foo }`        → propertyName=undefined, name=foo
        const localName = spec.propertyName?.text ?? spec.name.text;
        const exportedName = spec.name.text;
        if (!ctx.funcMap.has(localName)) continue;
        const funcIdx = ctx.funcMap.get(localName)!;
        const func = definedFuncAt(ctx, funcIdx);
        if (func && !func.exported) func.exported = true;
        if (!ctx.mod.exports.some((e) => e.name === exportedName)) {
          ctx.mod.exports.push({ name: exportedName, desc: { kind: "func", index: funcIdx } });
        }
      }
    }
  }

  // CJS exports: recognize `module.exports` / `exports.foo` patterns (#1075).
  // Phase 1 — register CJS function expressions and surface CJS assignments as Wasm exports.
  // This runs after the ESM export-default block so CJS and ESM don't conflict.
  if (isEntryFile) {
    // Helper: check if expression is `module.exports`
    function isModuleExports(e: ts.Expression): boolean {
      return (
        ts.isPropertyAccessExpression(e) &&
        ts.isIdentifier(e.expression) &&
        e.expression.text === "module" &&
        e.name.text === "exports"
      );
    }

    // Helper: extract export name from `module.exports.foo` or `exports.foo`
    function getCjsNamedExportName(e: ts.Expression): string | undefined {
      if (!ts.isPropertyAccessExpression(e)) return undefined;
      // module.exports.foo
      if (isModuleExports(e.expression)) return e.name.text;
      // exports.foo
      if (ts.isIdentifier(e.expression) && e.expression.text === "exports") return e.name.text;
      return undefined;
    }

    // Track whether we saw `module.exports = ...` (replaces entire exports object)
    let hasModuleExportsDefault = false;

    for (const stmt of sourceFile.statements) {
      if (!ts.isExpressionStatement(stmt)) continue;
      const expr = stmt.expression;
      if (!ts.isBinaryExpression(expr) || expr.operatorToken.kind !== ts.SyntaxKind.EqualsToken) continue;

      // Pattern 1: `module.exports = <ident>` — default export of an existing function
      if (isModuleExports(expr.left) && ts.isIdentifier(expr.right)) {
        const targetName = expr.right.text;
        if (ctx.funcMap.has(targetName)) {
          hasModuleExportsDefault = true;
          const funcIdx = ctx.funcMap.get(targetName)!;
          const func = definedFuncAt(ctx, funcIdx);
          if (func && !func.exported) func.exported = true;

          const alreadyExported = ctx.mod.exports.some((e) => e.desc.kind === "func" && e.desc.index === funcIdx);
          if (!alreadyExported) {
            ctx.mod.exports.push({ name: targetName, desc: { kind: "func", index: funcIdx } });
          }
          ctx.mod.exports.push({ name: "default", desc: { kind: "func", index: funcIdx } });
        }
        continue;
      }

      // Pattern 1b: `module.exports = function foo() {}` — default export of inline function
      if (isModuleExports(expr.left) && ts.isFunctionExpression(expr.right)) {
        hasModuleExportsDefault = true;
        const fnExpr = expr.right;
        const name = fnExpr.name?.text ?? "default";
        if (!ctx.funcMap.has(name)) {
          // Register the function expression
          const sig = ctx.checker.getSignatureFromDeclaration(fnExpr);
          if (sig) {
            const params: ValType[] = [];
            for (const param of fnExpr.parameters) {
              const paramType = ctx.checker.getTypeAtLocation(param);
              params.push(resolveWasmType(ctx, paramType));
            }
            const retType = ctx.checker.getReturnTypeOfSignature(sig);
            // (#2905) Carrier own-return guard — see findCallSignature. An async
            // function-expression export's own wasm result is the unwrapped T;
            // pre-unwrap under the carrier so the declared result matches the
            // raw-T body (else externref-result vs f64-body = invalid Wasm).
            // Carrier-gated → off-carrier bytes identical.
            const effRetType =
              isStandalonePromiseActive(ctx) && hasAsyncModifier(fnExpr)
                ? unwrapPromiseType(retType, ctx.checker)
                : retType;
            const results = isVoidType(effRetType) ? [] : [resolveWasmType(ctx, effRetType)];
            const typeIdx = addFuncType(ctx, params, results, `${name}_type`);
            const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
            ctx.funcMap.set(name, funcIdx);
            ctx.functionNameMap.set(name, fnExpr.name?.text ?? name);
            ctx.mod.functions.push({ name, typeIdx, locals: [], body: [], exported: true });
            ctx.mod.exports.push({ name, desc: { kind: "func", index: funcIdx } });
            if (name !== "default") {
              ctx.mod.exports.push({ name: "default", desc: { kind: "func", index: funcIdx } });
            }
          }
        }
        continue;
      }

      // Pattern 1c: `module.exports = { a, b: c, d }` — multi-named export via
      // object literal (#1277). Handles shorthand (`{ a }`) and named-with-
      // identifier (`{ alias: foo }`) shapes. Skips computed keys, methods,
      // spreads, and non-identifier RHS — those bail out without exporting
      // (a future enhancement could route generic-expression values through
      // a synthetic global).
      if (isModuleExports(expr.left) && ts.isObjectLiteralExpression(expr.right)) {
        hasModuleExportsDefault = true;
        for (const prop of expr.right.properties) {
          let key: string | undefined;
          let valName: string | undefined;
          if (ts.isShorthandPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
            key = prop.name.text;
            valName = key;
          } else if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && ts.isIdentifier(prop.initializer)) {
            key = prop.name.text;
            valName = prop.initializer.text;
          }
          if (!key || !valName) continue;
          if (!ctx.funcMap.has(valName)) continue;
          const funcIdx = ctx.funcMap.get(valName)!;
          const func = definedFuncAt(ctx, funcIdx);
          if (func && !func.exported) func.exported = true;
          if (!ctx.mod.exports.some((e) => e.name === key)) {
            ctx.mod.exports.push({ name: key, desc: { kind: "func", index: funcIdx } });
          }
        }
        continue;
      }

      // Pattern 2: `module.exports.foo = <fn>` or `exports.foo = <fn>` — named export
      const exportName = getCjsNamedExportName(expr.left);
      if (!exportName) continue;

      if (ts.isFunctionExpression(expr.right)) {
        const fnExpr = expr.right;
        const name = exportName;
        if (!ctx.funcMap.has(name)) {
          // Register the CJS function expression
          const sig = ctx.checker.getSignatureFromDeclaration(fnExpr);
          if (!sig) continue;
          const params: ValType[] = [];
          for (const param of fnExpr.parameters) {
            const paramType = ctx.checker.getTypeAtLocation(param);
            params.push(resolveWasmType(ctx, paramType));
          }
          const retType = ctx.checker.getReturnTypeOfSignature(sig);
          // (#2905) Carrier own-return guard — see findCallSignature. CJS named
          // function-expression export; pre-unwrap an async fn's Promise<T>
          // result under the carrier so the declared result matches the raw-T
          // body. Carrier-gated → off-carrier bytes identical.
          const effRetType =
            isStandalonePromiseActive(ctx) && hasAsyncModifier(fnExpr)
              ? unwrapPromiseType(retType, ctx.checker)
              : retType;
          const results = isVoidType(effRetType) ? [] : [resolveWasmType(ctx, effRetType)];
          const typeIdx = addFuncType(ctx, params, results, `${name}_type`);
          const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
          ctx.funcMap.set(name, funcIdx);
          ctx.functionNameMap.set(name, fnExpr.name?.text ?? name);
          ctx.mod.functions.push({ name, typeIdx, locals: [], body: [], exported: true });
          ctx.mod.exports.push({ name, desc: { kind: "func", index: funcIdx } });
        } else {
          // Function already registered (e.g., as a FunctionDeclaration) — just export it
          const funcIdx = ctx.funcMap.get(name)!;
          const func = definedFuncAt(ctx, funcIdx);
          if (func && !func.exported) func.exported = true;
          if (!ctx.mod.exports.some((e) => e.name === name)) {
            ctx.mod.exports.push({ name, desc: { kind: "func", index: funcIdx } });
          }
        }
      } else if (ts.isIdentifier(expr.right)) {
        // `exports.foo = someExistingFunction`
        const targetName = expr.right.text;
        if (ctx.funcMap.has(targetName)) {
          const funcIdx = ctx.funcMap.get(targetName)!;
          const func = definedFuncAt(ctx, funcIdx);
          if (func && !func.exported) func.exported = true;
          if (!ctx.mod.exports.some((e) => e.name === exportName)) {
            ctx.mod.exports.push({ name: exportName, desc: { kind: "func", index: funcIdx } });
          }
        }
      }
    }
  }

  // Fourth: collect module-level variable declarations as wasm globals
  /** Register a single module-level global variable with the given name and wasm type. */
  function registerModuleGlobal(name: string, wasmType: ValType): void {
    // Skip if shadowed by a *user* function — but NOT by a wasm:js-string
    // builtin import (#2669). `addStringImports` registers `concat`, `length`,
    // `equals`, `substring`, `charCodeAt` into `ctx.funcMap` (and mirrors them
    // in `ctx.jsStringImports`). Those builtin names are not user bindings, so a
    // module-level variable that merely *collides* with one — e.g. the test262
    // `let length = "outer"` dstr template (`ary-ptrn-rest-obj-prop-id` family),
    // or any captured `let concat`/`equals`/`substring`/`charCodeAt` — must still
    // be promoted to a `$__mod_<name>` global. Otherwise it stays a
    // `__module_init` local, invisible to every other function: reads from a
    // nested/exported function return null. The bare `funcMap.has` gate
    // conflated the two. Discriminate by index: when the funcMap entry IS the
    // js-string builtin (no genuine user function shadows the name), fall
    // through and register the global; a real user function of the same name
    // keeps the original skip behaviour.
    // (#3421) Generalize the #2669 discrimination: only a genuine USER function
    // (a DEFINED func, index >= numImportFuncs) shadows the var. A funcMap
    // entry that resolves to an IMPORT is a host/builtin binding — the ambient
    // DOM `declare function print(): void` from the lib scan registers an
    // `env.print` host import, and the test262 runtime shim's top-level
    // `var print = function (v) { console.log(v); }` was then silently denied
    // its module-global storage. With no storage, every cross-function call of
    // `print` (the async harness protocol: `$DONE` → `__consolePrintHandle__`
    // → `print`) compiled to a dropped no-op, so the oracle-v8 runner never
    // observed `Test262:AsyncTestComplete` — every `flags: [async]` test
    // failed (~4.6k). Per JS semantics the script-level `var` binding wins
    // over the ambient global for subsequent reads, so register the global.
    const fnIdx = ctx.funcMap.get(name);
    const shadowedByUserFunction =
      fnIdx !== undefined && fnIdx >= ctx.numImportFuncs && fnIdx !== ctx.jsStringImports.get(name);
    if (shadowedByUserFunction) return;
    if (ctx.moduleGlobals.has(name)) return; // skip if already registered
    if (ctx.classSet.has(name)) return; // skip class expression variables

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
      name: `__mod_${name}`,
      type: globalType,
      mutable: true,
      init,
    });
    ctx.moduleGlobals.set(name, globalIdx);
  }

  /** Register binding names from destructuring patterns as module globals. */
  function registerBindingNames(pattern: ts.BindingPattern): void {
    for (const element of pattern.elements) {
      if (ts.isOmittedExpression(element)) continue;
      if (ts.isIdentifier(element.name)) {
        const elemType = ctx.checker.getTypeAtLocation(element);
        const wasmType = resolveWasmType(ctx, elemType);
        registerModuleGlobal(element.name.text, wasmType);
      } else if (ts.isObjectBindingPattern(element.name) || ts.isArrayBindingPattern(element.name)) {
        registerBindingNames(element.name);
      }
    }
  }

  /**
   * (#2176) Resolve the wasm-relevant type of a module-level variable
   * declaration. `getTypeAtLocation(decl)` returns the declaration's
   * (initializer-inferred) type, but when the initializer is a bare identifier
   * that collides with an ambient lib global (e.g. `const y = name` where
   * `name` shadows lib.dom's `var name: string`), script-mode scoping makes the
   * checker bind the initializer reference to the ambient symbol (`void`), so
   * `y` is typed `void` → i32 global → value reads back as `0`/`undefined`.
   * Prefer the user-resolved initializer type in that case.
   */
  function moduleVarDeclType(decl: ts.VariableDeclaration): ts.Type {
    if (decl.initializer && ts.isIdentifier(decl.initializer)) {
      return resolveIdentifierType(ctx, decl.initializer);
    }
    return ctx.checker.getTypeAtLocation(decl);
  }

  /**
   * (#2011) True when a module-level variable's initializer is an object
   * literal carrying get/set accessor declarations (or a `[Symbol.dispose]`
   * / `[Symbol.asyncDispose]` computed method). Such literals compile through
   * the JS-host plain-object (externref) path in `compileObjectLiteral`
   * (#1239/#1433), so the receiving global MUST be typed `externref` — never
   * the inferred WasmGC struct type. Otherwise the host object is stored into
   * a struct-typed global and `obj.v` reads mis-route to `__extern_get` against
   * a struct (returning undefined → NaN). Mirrors the function-local pre-pass
   * in index.ts (`walkStmtForLetConst` / `hoistVarDecl`, ~12573-12586) that
   * already forces externref + tags `externrefAccessorVars` at function scope.
   */
  function moduleInitForcesExternref(decl: ts.VariableDeclaration): boolean {
    if (!decl.initializer) return false;
    // (#3365) Script top-level `this` is the host global object. The checker
    // describes it as the enormous structural `typeof globalThis` type, but
    // module init receives a genuine host externref. Keep the storage and all
    // subsequent member operations on that runtime representation; a typed
    // Wasm struct global would stay null and make `global.Infinity = 42` throw
    // the null-access payload before strict [[Set]] can produce TypeError.
    if (!ctx.sourceIsModule && decl.initializer.kind === ts.SyntaxKind.ThisKeyword) return true;
    if (!ts.isObjectLiteralExpression(decl.initializer)) return false;
    // (#3369) An untyped empty object literal is constructed by literals.ts as
    // a host `$Object` (`__new_plain_object`). Keep the module global on the
    // same externref representation unless a shape pre-pass deliberately
    // widened it into a closed struct/array-like carrier. Otherwise the
    // externref is guarded-cast into the zero-field inferred struct, stores
    // null, and later post-hoc protocol installation (`iter[Symbol.iterator]
    // = fn` / Object.defineProperty) operates on a lost value.
    if (decl.initializer.properties.length === 0 && ts.isIdentifier(decl.name)) {
      const name = decl.name.text;
      const widened = ctx.widenedTypeProperties.get(name);
      if ((!widened || widened.length === 0) && !ctx.shapeMap.has(name)) return true;
    }
    for (const p of decl.initializer.properties) {
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
    }
    // (#2804) A spread-containing object literal in a NON-SPECIFIC context (no
    // concrete contextual struct type — e.g. top-level `const b = { ...a, z: 3 }`)
    // is built as a host `$Object` (externref) by the literals.ts routing, NOT
    // the closed struct TS infers. The receiving global must be externref to
    // match (else the host object is ref.cast to the inferred struct → read
    // NaN/null), and reads route through `__extern_get`, preserving the spread's
    // runtime insertion-order keys + values. Mirrors the function-local sites
    // (statements/variables.ts, index.ts walkStmtForLetConst/hoistVarDecl);
    // inlined to keep the same lockstep predicate as the literals.ts routing.
    if (decl.initializer.properties.some((p) => ts.isSpreadAssignment(p))) {
      const spreadCtxType = ctx.checker.getContextualType(decl.initializer);
      if (
        !spreadCtxType ||
        (spreadCtxType.flags & ts.TypeFlags.Any) !== 0 ||
        (spreadCtxType.flags & ts.TypeFlags.Unknown) !== 0 ||
        (spreadCtxType.flags & ts.TypeFlags.NonPrimitive) !== 0 ||
        spreadCtxType.getProperties().length === 0
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Resolve the module-global wasm type for a simple identifier declaration,
   * honoring the accessor-literal externref override (#2011) and tagging the
   * name in `externrefAccessorVars` so later property accesses route to the
   * host get/set path. Shared by the `var`-hoist walk and the source-order
   * let/const pass so both scopes register the same type.
   */
  function moduleGlobalWasmType(decl: ts.VariableDeclaration, varType: ts.Type): ValType {
    if (moduleInitForcesExternref(decl) && ts.isIdentifier(decl.name)) {
      ctx.externrefAccessorVars.add(decl.name.text);
      return { kind: "externref" };
    }
    // (#2837) A module-level `var V = {non-empty literal}` marked growable by the
    // detection pre-pass (later out-of-shape / nested write, e.g. acorn's
    // `prototypeAccessors.inFunction.get = fn`) is built as an externref `$Object`
    // by the literals.ts routing, so the receiving GLOBAL must be externref too —
    // else the $Object is stored into a struct-typed global, the out-of-shape /
    // nested write is dropped, and the getter is never installed. Mirrors the
    // accessor-literal override above and the function-local sites
    // (statements/variables.ts).
    if (ts.isIdentifier(decl.name) && ctx.growableObjectLiteralVars.has(decl.name.text)) {
      ctx.externrefAccessorVars.add(decl.name.text);
      return { kind: "externref" };
    }
    // #1914 — `var m = re.exec(s)` under standalone gets the precise
    // match-vec ref type so indexed reads stay on the static vec path
    // (externref-widened globals round-trip through __extern_get_idx,
    // which can't see typed vecs and returns null).
    return inferStandaloneRegExpMatchGlobalType(ctx, decl) ?? resolveWasmType(ctx, varType);
  }

  /** Register var declarations from a variable declaration list as module globals. */
  function registerVarDeclListGlobals(list: ts.VariableDeclarationList): void {
    // Only hoist `var` (not let/const) — let/const are block-scoped
    if (list.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) return;
    for (const decl of list.declarations) {
      if (ts.isIdentifier(decl.name)) {
        const varType = moduleVarDeclType(decl);
        const wasmType = moduleGlobalWasmType(decl, varType);
        registerModuleGlobal(decl.name.text, wasmType);
      } else if (ts.isObjectBindingPattern(decl.name) || ts.isArrayBindingPattern(decl.name)) {
        registerBindingNames(decl.name);
      }
    }
  }

  /**
   * Recursively walk a statement to find and register `var` declarations
   * as module globals. This implements JavaScript var-hoisting semantics
   * at the module level: `var` declarations inside for-loops, if-blocks,
   * try/catch, switch, etc. are hoisted to the module scope.
   */
  function walkModuleStmtForVars(stmt: ts.Statement): void {
    if (ts.isVariableStatement(stmt)) {
      if (hasDeclareModifier(stmt)) return;
      registerVarDeclListGlobals(stmt.declarationList);
      return;
    }
    if (ts.isBlock(stmt)) {
      for (const s of stmt.statements) walkModuleStmtForVars(s);
      return;
    }
    if (ts.isIfStatement(stmt)) {
      walkModuleStmtForVars(stmt.thenStatement);
      if (stmt.elseStatement) walkModuleStmtForVars(stmt.elseStatement);
      return;
    }
    if (ts.isWhileStatement(stmt) || ts.isDoStatement(stmt)) {
      walkModuleStmtForVars(stmt.statement);
      return;
    }
    if (ts.isForStatement(stmt)) {
      if (stmt.initializer && ts.isVariableDeclarationList(stmt.initializer)) {
        registerVarDeclListGlobals(stmt.initializer);
      }
      walkModuleStmtForVars(stmt.statement);
      return;
    }
    if (ts.isForInStatement(stmt) || ts.isForOfStatement(stmt)) {
      if (stmt.initializer && ts.isVariableDeclarationList(stmt.initializer)) {
        registerVarDeclListGlobals(stmt.initializer);
      }
      walkModuleStmtForVars(stmt.statement);
      return;
    }
    if (ts.isLabeledStatement(stmt)) {
      walkModuleStmtForVars(stmt.statement);
      return;
    }
    if (ts.isTryStatement(stmt)) {
      for (const s of stmt.tryBlock.statements) walkModuleStmtForVars(s);
      if (stmt.catchClause) {
        for (const s of stmt.catchClause.block.statements) walkModuleStmtForVars(s);
      }
      if (stmt.finallyBlock) {
        for (const s of stmt.finallyBlock.statements) walkModuleStmtForVars(s);
      }
      return;
    }
    if (ts.isSwitchStatement(stmt)) {
      for (const clause of stmt.caseBlock.clauses) {
        for (const s of clause.statements) walkModuleStmtForVars(s);
      }
    }
  }

  // Single pass preserves source order, which matters for statements that depend on
  // side effects from earlier statements (e.g. `(Ctor as any).prototype = proto` must
  // run before `new Ctor()` captures the prototype, and `obj.prop = v` must run between
  // `var before = ...typeof obj.prop` and `var after = ...obj.prop === v`).
  for (const stmt of sourceFile.statements) {
    if (ts.isVariableStatement(stmt)) {
      if (hasDeclareModifier(stmt)) continue;
      // Track let/const for TDZ enforcement
      const isLetOrConst = (stmt.declarationList.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) !== 0;
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          const varType = moduleVarDeclType(decl);
          // (#2011) Accessor/dispose object-literal initializers force an
          // externref global (+ externrefAccessorVars tag); otherwise fall back
          // to the standalone-regexp / inferred type. See moduleGlobalWasmType.
          const wasmType = moduleGlobalWasmType(decl, varType);
          registerModuleGlobal(decl.name.text, wasmType);
          if (isLetOrConst) {
            ctx.tdzLetConstNames.add(decl.name.text);
          }
        } else if (ts.isObjectBindingPattern(decl.name) || ts.isArrayBindingPattern(decl.name)) {
          registerBindingNames(decl.name);
        }
      }
      // Collect the statement for init compilation (skip pure class expression bindings)
      const hasNonClassDecl = stmt.declarationList.declarations.some(
        (d) => !(ts.isIdentifier(d.name) && d.initializer && ts.isClassExpression(d.initializer)),
      );
      if (hasNonClassDecl) {
        ctx.moduleInitStatements.push(stmt);
      }
      continue;
    }
    // For control-flow statements at module level, recursively scan for
    // `var` declarations (JavaScript var-hoisting) and collect the statement
    // for init compilation so it executes at module load time.
    if (
      ts.isForStatement(stmt) ||
      ts.isForInStatement(stmt) ||
      ts.isForOfStatement(stmt) ||
      ts.isWhileStatement(stmt) ||
      ts.isDoStatement(stmt) ||
      ts.isIfStatement(stmt) ||
      ts.isTryStatement(stmt) ||
      ts.isSwitchStatement(stmt) ||
      ts.isLabeledStatement(stmt)
    ) {
      walkModuleStmtForVars(stmt);
      ctx.moduleInitStatements.push(stmt);
      continue;
    }
    if (ts.isBlock(stmt)) {
      walkModuleStmtForVars(stmt);
      ctx.moduleInitStatements.push(stmt);
      continue;
    }
    // (#2968) A top-level `throw` under `--target wasi`: collect it into
    // `__module_init` so the statement actually executes at module load and its
    // exception propagates out to `_start`, where the uncaught-exception printer
    // (addWasiStartExport) renders it to stderr + `proc_exit(1)`. Without this
    // there is no `ThrowStatement` case, so a bare top-level `throw` was silently
    // dropped — it emitted no code at all and the program exited 0. Gated on
    // `ctx.wasi` so JS-host / plain-standalone output stays byte-identical (their
    // pre-existing top-level-throw drop is out of scope for this issue).
    if (ts.isThrowStatement(stmt)) {
      if (ctx.wasi) ctx.moduleInitStatements.push(stmt);
      continue;
    }
    // Module-level expression statements with side effects:
    // new expressions, call expressions, ++/--, assignments to module globals
    if (ts.isExpressionStatement(stmt)) {
      // #1596 — the test262 IIFE-with-trailing-call pattern
      // `(function(){...}.apply(null, [...]))` parses with a
      // ParenthesizedExpression at the top of the ExpressionStatement. Unwrap
      // here so the inner CallExpression is recognised and the statement
      // reaches `__module_init`.
      let expr: ts.Expression = stmt.expression;
      // (#2992) `void <expr>` evaluates its operand for side effects and
      // discards the result — in statement position it is transparent, so
      // unwrap it like parentheses (`void (delete o.k)` must still delete).
      while (ts.isParenthesizedExpression(expr) || ts.isVoidExpression(expr)) {
        expr = expr.expression;
      }
      if (ts.isNewExpression(expr) || ts.isCallExpression(expr)) {
        ctx.moduleInitStatements.push(stmt);
        continue;
      }
      if (ts.isPrefixUnaryExpression(expr) || ts.isPostfixUnaryExpression(expr)) {
        ctx.moduleInitStatements.push(stmt);
        continue;
      }
      // (#2992) Top-level `delete o.k` / `delete o["k"]` — a DeleteExpression
      // is its OWN node kind (NOT a PrefixUnaryExpression), so it matched no
      // case here and was silently dropped from `__module_init`: the property
      // survived, every later read observed the stale value, and `"k" in o`
      // stayed true. Delete INSIDE a function always worked — only the
      // top-level collection dropped it. This was the mechanism behind the
      // #2992 "delete-tombstone read survival" headline repro. Affects ALL
      // lanes (gc/standalone/wasi) identically; programs without a top-level
      // delete statement are byte-identical.
      if (ts.isDeleteExpression(expr)) {
        ctx.moduleInitStatements.push(stmt);
        continue;
      }
      if (ts.isBinaryExpression(expr)) {
        const opKind = expr.operatorToken.kind;
        const isAssignOp =
          opKind === ts.SyntaxKind.EqualsToken ||
          opKind === ts.SyntaxKind.PlusEqualsToken ||
          opKind === ts.SyntaxKind.MinusEqualsToken ||
          opKind === ts.SyntaxKind.AsteriskEqualsToken ||
          opKind === ts.SyntaxKind.SlashEqualsToken ||
          opKind === ts.SyntaxKind.PercentEqualsToken ||
          opKind === ts.SyntaxKind.AmpersandEqualsToken ||
          opKind === ts.SyntaxKind.BarEqualsToken ||
          opKind === ts.SyntaxKind.CaretEqualsToken ||
          opKind === ts.SyntaxKind.LessThanLessThanEqualsToken ||
          opKind === ts.SyntaxKind.GreaterThanGreaterThanEqualsToken ||
          opKind === ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken ||
          // #1268 — logical-assignment operators (??=, ||=, &&=) are also
          // assignment ops with side effects; without these, top-level
          // statements like `d["x"] ??= 42` were silently dropped from
          // `__module_init`, leaving the LHS uninitialised and reads
          // returning NaN/undefined.
          opKind === ts.SyntaxKind.QuestionQuestionEqualsToken ||
          opKind === ts.SyntaxKind.BarBarEqualsToken ||
          opKind === ts.SyntaxKind.AmpersandAmpersandEqualsToken;
        if (!isAssignOp) continue;
        // (#3366) A destructuring-assignment LHS has no single root identifier,
        // so getAssignmentRootIdentifier below returns undefined and the whole
        // top-level statement used to be dropped. Keep it unconditionally:
        // evaluating the RHS/iterator/property reads/default initializers and
        // performing each PutValue are all observable, even when no target is
        // a module binding. The assignment compiler performs the per-leaf
        // local/module/global resolution.
        if (
          opKind === ts.SyntaxKind.EqualsToken &&
          (ts.isArrayLiteralExpression(expr.left) || ts.isObjectLiteralExpression(expr.left))
        ) {
          ctx.moduleInitStatements.push(stmt);
          continue;
        }
        // (#1719 CPR) `Array.prototype[Symbol.iterator] = fn` / `.values = fn`
        // has no module-global root identifier (`Array` is a builtin), so the
        // generic check below drops it. When the S1 brand is set, keep it in
        // __module_init so the CPR write-arm (compileAssignment) captures the
        // override closure. Gated — byte-identical when no override exists.
        if (ctx.arrayIteratorMaybeOverridden && isArrayProtoIteratorAssignTarget(expr.left)) {
          ctx.moduleInitStatements.push(stmt);
          continue;
        }
        // (#2660 S2) `F.prototype = …` / `F.prototype.p = …` for a user fnctor `F`
        // (standalone): the root identifier `F` is a function, NOT a module
        // global, so the generic check below drops the statement and the
        // prototype write never reaches compilePropertyAssignment (the S2
        // interception). Keep it in __module_init so the per-fnctor prototype
        // `$Object` is populated. Host/GC mode is byte-identical (gated, dropped
        // as before). Mirrors the Array.prototype CPR keep-in-init above.
        if (ctx.standalone && isFnctorPrototypeAssignTarget(ctx, expr.left)) {
          ctx.moduleInitStatements.push(stmt);
          continue;
        }
        // (#2671) `F.<prop> = …` — a STATIC property write on a top-level
        // FUNCTION DECLARATION (`Test262Error.thrower = function () {…}`, the
        // test262 harness-prelude shape every Promise capability test passes
        // as its reject callback). `F` is not a module global, so the generic
        // check below dropped the statement: the static silently never
        // existed at runtime (wasm-side reads → null → call traps; the host
        // mirror shows undefined → V8's NewPromiseCapability throws "Promise
        // resolve or reject function is not callable"). Keep the statement in
        // __module_init so the ordinary property-write arm runs — the same
        // write from inside a function already worked; only the top-level
        // collection dropped it. Scoped narrowly:
        //   - DIRECT `F.<name> = …` only (bare-identifier receiver);
        //     `F.prototype.m = …` chains stay excluded (non-identifier
        //     receiver — the generic check below still drops them).
        //   - (#3049 Layer 1 / #3123) DIRECT `F.prototype = …` is now ALSO
        //     kept for host/GC. The old exclusion claimed the compile-time
        //     fnctor-prototype lift consumes it, but
        //     `tryCompileFnctorPrototypeAssign` opens with
        //     `if (!ctx.standalone) return undefined` — the lift is
        //     STANDALONE-ONLY, so in host mode nothing consumed the statement
        //     and it was silently elided. `F.prototype` reads then fell back
        //     to the auto-vivified #1712 sidecar object (non-null but
        //     empty), dropping the assigned prototype object and its whole
        //     chain. This elision is what kept the test262-runner harness
        //     shim `Iterator.prototype = getPrototypeOf(getPrototypeOf(
        //     [][Symbol.iterator]()))` from ever running, so `class C
        //     extends Iterator` instances could not reach the ES2025
        //     Iterator-helper prototype (#3123). No double-apply is possible
        //     in host mode; standalone keeps its own #2660 S2 arm above and
        //     stays byte-identical.
        //   - Host/GC lanes only: standalone's write-arm for fnctor statics
        //     is separate work (its prototype case has its own #2660 S2 keep
        //     above); standalone codegen stays byte-identical.
        //   - The receiver is unwrapped through parens / `as`-casts /
        //     non-null assertions (the harness shim writes
        //     `(Iterator as any).prototype = …`; the cast must not hide the
        //     top-level-function receiver — same unwrap
        //     getAssignmentRootIdentifier applies).
        if (!ctx.standalone && ts.isPropertyAccessExpression(expr.left)) {
          let receiver: ts.Expression = expr.left.expression;
          while (
            ts.isParenthesizedExpression(receiver) ||
            ts.isAsExpression(receiver) ||
            ts.isNonNullExpression(receiver) ||
            ts.isTypeAssertionExpression(receiver)
          ) {
            receiver = receiver.expression;
          }
          if (ts.isIdentifier(receiver) && ctx.topLevelFunctionNames.has(receiver.text)) {
            ctx.moduleInitStatements.push(stmt);
            continue;
          }
          // (#2623 P-7b) `Promise.<prop> = …` — a top-level static patch on the
          // BUILTIN Promise (the test262 observable-resolve shape
          // `Promise.resolve = function(){…}`, `all/race invoke-resolve.js`).
          // `Promise` is neither a module global nor a top-level function, so
          // the generic check below dropped the statement — the patch silently
          // never existed at runtime (the exact #2671 `Test262Error.thrower`
          // elision mechanism). Keep it in `__module_init` so the ordinary
          // property-write arm runs: the write routes through `__extern_set`
          // onto the `declared_global`-resolved Promise. In the single-realm
          // CI lane (no vm sandbox) that IS `globalThis.Promise` — the same
          // object the combinator capability `C` (`_resolveCtor`, runtime.ts)
          // passes to V8, so `Get(C,"resolve")` observes the patch; the CI
          // worker's #1220 static snapshot/restore un-patches it after each
          // test. In the LOCAL sandboxed runner the write lands on the
          // sandbox Promise (inert for the host-realm capability lane; the
          // `["Promise","resolve"]` SENTINEL_KEYS entry discards the dirty
          // sandbox) — the local lane deliberately does NOT chase realm
          // unification (P-7b design decision, see the issue file). Host/GC
          // lane + `Promise` receiver only — a blanket builtin-receiver keep
          // flips patches on every builtin at once and is separate, measured
          // work. Shadowed user bindings named `Promise` are module globals /
          // functions and are caught by the arms above/below, never reaching
          // this keep.
          if (
            ts.isIdentifier(receiver) &&
            receiver.text === "Promise" &&
            !ctx.moduleGlobals.has("Promise") &&
            !ctx.topLevelFunctionNames.has("Promise") &&
            !ctx.classSet.has("Promise")
          ) {
            ctx.moduleInitStatements.push(stmt);
            continue;
          }
        }
        const targetName = getAssignmentRootIdentifier(expr.left);
        if (targetName && ctx.moduleGlobals.has(targetName)) {
          ctx.moduleInitStatements.push(stmt);
        }
      }
    }
  }

  // Export default for module globals (#1108): `export default <variable>` where
  // the variable is a module-level global (e.g. `var add = createMathOperation(fn, 0)`)
  // This runs AFTER module globals are registered (Fourth pass above).
  if (isEntryFile) {
    for (const stmt of sourceFile.statements) {
      if (!ts.isExportAssignment(stmt) || stmt.isExportEquals) continue;
      if (!ts.isIdentifier(stmt.expression)) continue;
      const varName = stmt.expression.text;
      // Skip if already handled as a function export
      if (ctx.funcMap.has(varName)) continue;
      if (ctx.moduleGlobals.has(varName)) {
        // Defer the actual export — global indices are not final yet because
        // later collectDeclarations calls may add string-constant import globals
        // which shift all defined-global indices.  Record the variable name
        // and resolve the correct absolute index in a fixup pass.
        if (!ctx.deferredDefaultGlobalExport) {
          ctx.deferredDefaultGlobalExport = varName;
        }
      }
    }
  }
}

/** Compile all function bodies (including class constructors and methods) */
/**
 * Third pass — compile function bodies into the slots pre-allocated by
 * `collectDeclarations`.
 *
 * (#2138) `skipBodies` — IR-first compile-once inversion, ONLY passed when
 * `JS2WASM_IR_FIRST=1`: top-level FunctionDeclarations named in the set get
 * an `unreachable` placeholder body instead of a legacy compile (the IR
 * overlay overwrites the slot afterwards, so each claimed function is
 * compiled ONCE). The funcIdx/typeIdx slot itself is untouched — this is a
 * body-emission change, never an index-layout change. Skipped functions are
 * deliberately NOT registered as inlinable (callers must emit a real `call`
 * to the slot; inlining the placeholder — or a legacy body that will be
 * discarded — would defeat the inversion). Returns the names actually
 * skipped (undefined when `skipBodies` is not passed — the default path
 * allocates nothing).
 */
export function compileDeclarations(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile,
  skipBodies?: ReadonlySet<string>,
): string[] | undefined {
  const skippedNames: string[] | undefined = skipBodies ? [] : undefined;
  // Build a map from function name → index within ctx.mod.functions
  const funcByName = new Map<string, number>();
  for (let i = 0; i < ctx.mod.functions.length; i++) {
    funcByName.set(ctx.mod.functions[i]!.name, i);
  }
  const siblingFunctionLists = new WeakSet<object>();

  function statementListHasEagerClass(stmts: ts.NodeArray<ts.Statement> | readonly ts.Statement[]): boolean {
    for (const stmt of stmts) {
      const isAmbient = hasDeclareModifier(stmt) || stmt.getSourceFile().isDeclarationFile;
      if (ts.isClassDeclaration(stmt) && stmt.name && !isAmbient) return true;
      if (ts.isVariableStatement(stmt) && !isAmbient) {
        for (const decl of stmt.declarationList.declarations) {
          if (ts.isIdentifier(decl.name) && decl.initializer && ts.isClassExpression(decl.initializer)) return true;
        }
      }
      let hasClassExpression = false;
      const visit = (node: ts.Node): void => {
        if (hasClassExpression) return;
        if (ts.isClassExpression(node)) {
          hasClassExpression = true;
          return;
        }
        forEachChild(node, visit);
      };
      forEachChild(stmt, visit);
      if (hasClassExpression) return true;
    }
    return false;
  }

  function ensureSiblingFunctionsRegistered(stmts: ts.NodeArray<ts.Statement> | readonly ts.Statement[]): void {
    if (siblingFunctionLists.has(stmts as object)) return;
    siblingFunctionLists.add(stmts as object);
    if (!statementListHasEagerClass(stmts)) return;

    for (const sibling of stmts) {
      if (!ts.isFunctionDeclaration(sibling) || !sibling.name || !sibling.body) continue;
      if (hasDeclareModifier(sibling) || ctx.funcMap.has(sibling.name.text)) continue;
      if (functionDeclarationCapturesEnclosingLocal(ctx, sibling)) continue;
      registerBodylessFunctionDeclaration(ctx, sibling, sourceFile);
    }
  }

  // (#2818) Collect the names of *block-scoped* (`let`/`const`) variables
  // declared directly in a statement list (not descending into nested blocks
  // or function bodies). Only `let`/`const` — a `var` is function-scoped and,
  // when referenced by a class method, is already hoisted to a module global
  // (see `wrapTest` and the module-global skip in
  // `promoteAccessorCapturesToGlobals`), so it needs no deferral; including
  // `var` needlessly perturbed the order-sensitive async-generator lowering.
  function collectBlockScopedDeclNames(
    stmts: ts.NodeArray<ts.Statement> | readonly ts.Statement[],
    out: Set<string>,
  ): void {
    for (const stmt of stmts) {
      if (!ts.isVariableStatement(stmt)) continue;
      const isBlockScoped = (stmt.declarationList.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) !== 0;
      if (!isBlockScoped) continue;
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          out.add(decl.name.text);
        } else if (ts.isObjectBindingPattern(decl.name) || ts.isArrayBindingPattern(decl.name)) {
          collectBindingPatternNames(decl.name, out);
        }
      }
    }
  }

  // (#2818) True iff any method / constructor / accessor body — or a
  // parameter-default initializer — of `decl` references a name in `names`
  // that `promoteAccessorCapturesToGlobals` would actually promote. Mirrors the
  // member set AND the skip conditions of that function (already a module /
  // captured global, `this`, a user-function name), so we defer a class only
  // when the in-scope promotion channel would genuinely fire — never on a name
  // that is already global (a false-positive defer only churns codegen order).
  function classDeclCapturesNames(decl: ts.ClassDeclaration, names: ReadonlySet<string>): boolean {
    if (names.size === 0) return false;
    // (#2818 standalone follow-up) In the STANDALONE/WASI lane, NEVER defer a
    // class that has a base class (`extends …`). A derived class routes its
    // constructor through a `super(...)` call; the deferred, block-recompiled
    // path lowers that super-constructor invocation + any spread/getter in the
    // arguments *correctly in the WasmGC (host) lane* but produces a
    // **desynced** result in the standalone lane (the promoted-global read of
    // a captured `let` resolves to a stale/empty value through the super/
    // spread machinery). The *eager* path — which is exactly how `origin/main`
    // compiled these — is correct in the standalone lane, so standalone keeps
    // every derived class eager. This had regressed 6 standalone test262 files
    // (all `class X extends Iterator` / `extends Parent` capturers: the
    // `Iterator.prototype.{map,flatMap,take,drop,filter}`
    // `return-is-forwarded*` tests + `super/call-spread-obj-getter-init`).
    //
    // (#3123) The HOST lane takes the opposite branch: an EAGER capturing
    // derived class compiles before the block-`let` initialises, so
    // `promoteAccessorCapturesToGlobals` never fires and the method body's
    // capture read/write lowers to a silent no-op (`f64.const NaN; drop` —
    // verified via WAT on the `class TestIterator extends Iterator {
    // return() { ++returnCount; } }`-in-`try` shape of the Iterator-helper
    // `return-is-forwarded` files). The deferred path is documented correct
    // for host above, so host defers derived capturers like base-less ones.
    if ((ctx.standalone || ctx.wasi) && decl.heritageClauses?.some((h) => h.token === ts.SyntaxKind.ExtendsKeyword)) {
      return false;
    }
    const wouldPromote = (name: string): boolean => {
      if (!names.has(name)) return false;
      if (name === "this") return false;
      if (ctx.capturedGlobals.has(name)) return false;
      if (ctx.moduleGlobals.has(name)) return false;
      // A name bound to a *user* function is a function reference, not a
      // captured variable (but a same-named wasm:js-string builtin import must
      // not block capture — discriminate by index, as promotion does).
      if (ctx.funcMap.has(name) && ctx.funcMap.get(name) !== ctx.jsStringImports.get(name)) return false;
      return true;
    };
    for (const member of decl.members) {
      const isBodied =
        ts.isMethodDeclaration(member) ||
        ts.isConstructorDeclaration(member) ||
        ts.isGetAccessorDeclaration(member) ||
        ts.isSetAccessorDeclaration(member);
      if (!isBodied) continue;
      const referenced = new Set<string>();
      const body = (member as ts.MethodDeclaration).body;
      if (body) {
        for (const stmt of body.statements) collectReferencedIdentifiers(stmt, referenced);
      }
      for (const p of (member as ts.MethodDeclaration).parameters) {
        if (p.initializer) collectReferencedIdentifiers(p.initializer, referenced);
      }
      for (const name of referenced) {
        if (wouldPromote(name)) return true;
      }
    }
    return false;
  }

  // Compile class constructors and methods
  // Also compile class expressions in variable declarations
  // Scan recursively into function bodies for class expressions
  function compileClassesFromStatements(
    stmts: ts.NodeArray<ts.Statement> | readonly ts.Statement[],
    insideFunction = false,
    // (#2818) When non-null, we are (transitively) inside a function body and
    // this set carries the enclosing block/function-scoped `let`/`const`/`var`
    // names in scope, so a control-flow-nested class *declaration* that
    // genuinely captures one of them can be deferred (compiled in-scope by
    // `compileNestedClassDeclaration`) instead of eagerly. `null` at module
    // scope — nothing new is deferred there. See the block-`let`-captured-by-
    // class-method ordering bug (#2818); the broad `insideFunction`-everywhere
    // variant (PR #2335) regressed −471 by also deferring class *expressions*
    // and non-capturing classes whose deferred shape is not re-compiled.
    enclosingLocals: Set<string> | null = null,
  ): void {
    if (!insideFunction) {
      ensureSiblingFunctionsRegistered(stmts);
    }
    // (#2818) When inside a function, accumulate this statement list's own
    // block-scoped decls onto the inherited set so a class nested deeper can
    // detect a capture of a `let`/`const`/`var` from this or an enclosing
    // block. A fresh copy per level keeps sibling blocks from polluting each
    // other. `null` at module scope (no new deferral there).
    let scopeLocals: Set<string> | null = enclosingLocals;
    if (enclosingLocals) {
      scopeLocals = new Set(enclosingLocals);
      collectBlockScopedDeclNames(stmts, scopeLocals);
    }
    for (const stmt of stmts) {
      // Mirror the `.d.ts` ambient guard from `collectClassesFromStatements`:
      // there is no body to compile for classes declared in declaration
      // files. (#1287)
      const isAmbient = hasDeclareModifier(stmt) || stmt.getSourceFile().isDeclarationFile;
      if (ts.isClassDeclaration(stmt) && stmt.name && !isAmbient) {
        if (insideFunction) {
          // Defer body compilation — will be compiled in compileNestedClassDeclaration
          // when the enclosing function is compiled (so captured locals are available)
          ctx.deferredClassBodies.add(stmt.name.text);
        } else if (scopeLocals && classDeclCapturesNames(stmt, scopeLocals)) {
          // (#2818) A control-flow-nested class *declaration* (block / if /
          // loop / switch / try / labeled body inside a function) that captures
          // an enclosing block-scoped local. Eager compilation here runs before
          // the block-`let` initialises, so `promoteAccessorCapturesToGlobals`
          // never fires and the method reads null. Defer it: it is re-compiled
          // in-scope by `compileNestedClassDeclaration` (reached from
          // `compileStatement` for a class declaration in ANY statement
          // position), where the local is live and promotion succeeds. Only
          // genuine capturers are deferred — class expressions and
          // non-capturing classes stay eager (the −471 PR #2335 shapes).
          ctx.deferredClassBodies.add(stmt.name.text);
        } else {
          try {
            compileClassBodies(ctx, stmt, funcByName);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            reportError(ctx, stmt, `Internal error compiling class '${stmt.name.text}': ${msg}`);
          }
        }
      } else if (ts.isVariableStatement(stmt) && !isAmbient) {
        for (const decl of stmt.declarationList.declarations) {
          if (ts.isIdentifier(decl.name) && decl.initializer && ts.isClassExpression(decl.initializer)) {
            if (insideFunction) {
              // (#3045 Bug 2) Defer the class-expression BODY compilation to the
              // in-scope variable path so its constructor/method bodies can
              // capture the enclosing function scope — call enclosing functions
              // and read/write enclosing locals — exactly as a nested class
              // DECLARATION does (deferred just above, compiled in-scope by
              // `compileNestedClassDeclaration`). Key the deferral by the
              // SYNTHETIC name the class was collected under (`anonClassExprNames`)
              // — the name its ctor/method funcs live under and that
              // `compileClassExpression` resolves — NOT the binding name (which
              // is a dead duplicate registration, #1394). The in-scope compile
              // runs in `compileVariableStatement`. Without this, the body was
              // compiled eagerly at module scope (in `compileAnonymousClassBodies
              // InNode` below) BEFORE the enclosing function's nested functions
              // were registered and BEFORE its captured locals were promoted to
              // globals → enclosing calls returned garbage and enclosing writes
              // were dropped.
              const synth = ctx.anonClassExprNames.get(decl.initializer);
              if (synth !== undefined) ctx.deferredClassBodies.add(synth);
            } else {
              try {
                compileClassBodies(ctx, decl.initializer, funcByName, decl.name.text);
              } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                reportError(ctx, decl, `Internal error compiling class expression: ${msg}`);
              }
            }
          }
          // Recurse into arrow functions and function expressions
          if (decl.initializer) {
            compileClassesFromFunctionBody(decl.initializer);
          }
        }
      } else if (ts.isFunctionDeclaration(stmt) && stmt.body) {
        // Entering a function body: start a fresh enclosing-locals scope so
        // nested classes can detect captures of this function's block-locals.
        compileClassesFromStatements(stmt.body.statements, true, new Set());
      } else if (ts.isIfStatement(stmt)) {
        // (#2818) Forward `scopeLocals` (not `insideFunction`) through control-
        // flow bodies. This does NOT change the eager/deferred decision for
        // non-capturing classes or class expressions — only enables the
        // capture-defer branch above for genuine block-`let` capturers.
        if (ts.isBlock(stmt.thenStatement)) {
          compileClassesFromStatements(stmt.thenStatement.statements, false, scopeLocals);
        }
        if (stmt.elseStatement && ts.isBlock(stmt.elseStatement)) {
          compileClassesFromStatements(stmt.elseStatement.statements, false, scopeLocals);
        }
      } else if (ts.isBlock(stmt)) {
        compileClassesFromStatements(stmt.statements, false, scopeLocals);
      } else if (
        ts.isForStatement(stmt) ||
        ts.isForInStatement(stmt) ||
        ts.isForOfStatement(stmt) ||
        ts.isWhileStatement(stmt) ||
        ts.isDoStatement(stmt)
      ) {
        const body = stmt.statement;
        if (ts.isBlock(body)) {
          compileClassesFromStatements(body.statements, false, scopeLocals);
        }
      } else if (ts.isSwitchStatement(stmt)) {
        for (const clause of stmt.caseBlock.clauses) {
          compileClassesFromStatements(clause.statements, false, scopeLocals);
        }
      } else if (ts.isTryStatement(stmt)) {
        compileClassesFromStatements(stmt.tryBlock.statements, false, scopeLocals);
        if (stmt.catchClause) {
          compileClassesFromStatements(stmt.catchClause.block.statements, false, scopeLocals);
        }
        if (stmt.finallyBlock) {
          compileClassesFromStatements(stmt.finallyBlock.statements, false, scopeLocals);
        }
      } else if (ts.isLabeledStatement(stmt)) {
        if (ts.isBlock(stmt.statement)) {
          compileClassesFromStatements(stmt.statement.statements, false, scopeLocals);
        }
      }
      // Compile bodies for anonymous class expressions in new expressions
      compileAnonymousClassBodiesInNode(stmt);
    }
  }

  /** Recurse into arrow functions and function expressions to compile class bodies */
  function compileClassesFromFunctionBody(expr: ts.Expression): void {
    if (ts.isArrowFunction(expr)) {
      if (ts.isBlock(expr.body)) {
        // Fresh enclosing-locals scope for the arrow's own body (#2818).
        compileClassesFromStatements(expr.body.statements, true, new Set());
      }
    } else if (ts.isFunctionExpression(expr)) {
      if (expr.body) {
        // Fresh enclosing-locals scope for the function expression body (#2818).
        compileClassesFromStatements(expr.body.statements, true, new Set());
      }
      // Compile bodies for anonymous class expressions in new expressions
      compileAnonymousClassBodiesInNode(expr);
    }
  }

  // Recursively scan for class expressions and compile the class bodies
  const compiledAnonClasses = new Set<ts.ClassExpression>();
  function compileAnonClassIfNeeded(classExpr: ts.ClassExpression): void {
    if (compiledAnonClasses.has(classExpr)) return;
    const syntheticName = ctx.anonClassExprNames.get(classExpr);
    if (syntheticName) {
      compiledAnonClasses.add(classExpr);
      // (#3045 Bug 2) A class-expression body deferred to the in-scope variable
      // path (see the VariableStatement branch in `compileClassesFromStatements`)
      // must NOT be eagerly compiled here at module scope — its ctor/method
      // bodies are compiled in `compileVariableStatement`, where the enclosing
      // function scope is live. It is already marked handled (added to
      // `compiledAnonClasses` above) so it is never eager-compiled; skip.
      if (ctx.deferredClassBodies.has(syntheticName)) return;
      try {
        compileClassBodies(ctx, classExpr, funcByName, syntheticName);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        reportError(ctx, classExpr, `Internal error compiling anonymous class: ${msg}`);
      }
    }
  }
  function compileAnonymousClassBodiesInNode(node: ts.Node): void {
    if (ts.isNewExpression(node)) {
      let inner: ts.Expression = node.expression;
      while (ts.isParenthesizedExpression(inner)) {
        inner = inner.expression;
      }
      if (ts.isClassExpression(inner)) {
        compileAnonClassIfNeeded(inner);
      }
    }
    // Also compile class expressions in any other position
    if (ts.isClassExpression(node)) {
      compileAnonClassIfNeeded(node);
    }
    forEachChild(node, compileAnonymousClassBodiesInNode);
  }

  compileClassesFromStatements(sourceFile.statements);

  // Compile away TDZ tracking for definite-assignment top-level let/const
  // variables (#906). If every read of a top-level let/const can be statically
  // proven to occur after its initializer (analyzeTdzAccess returns "skip"),
  // we drop the variable from `tdzLetConstNames` so:
  //   - no `__tdz_<name>` flag global is allocated below,
  //   - `emitTdzInit` becomes a no-op (no `i32.const 1; global.set` writes
  //     in `__module_init`),
  //   - `emitTdzCheck` becomes a no-op (no runtime check at reads).
  // Genuinely dynamic / ambiguous cases (e.g. function declarations that
  // could be called before the variable's initializer runs) are preserved
  // because `analyzeTdzAccess` conservatively returns "check" for them.
  const elidableTdzNames = computeElidableTopLevelTdzNames(ctx, sourceFile, ctx.tdzLetConstNames);
  for (const name of elidableTdzNames) {
    ctx.tdzLetConstNames.delete(name);
  }

  // Create TDZ flag globals for let/const module globals.
  // Each TDZ flag is an i32 global initialized to 0 (uninitialized).
  // When the variable's initializer runs, the flag is set to 1.
  // Reads of the variable check the flag and throw ReferenceError if 0.
  for (const name of ctx.tdzLetConstNames) {
    if (!ctx.moduleGlobals.has(name)) continue; // safety check
    const flagGlobalIdx = nextModuleGlobalIdx(ctx);
    ctx.mod.globals.push({
      name: `__tdz_${name}`,
      type: { kind: "i32" },
      mutable: true,
      init: [{ op: "i32.const", value: 0 }],
    });
    ctx.tdzGlobals.set(name, flagGlobalIdx);
  }

  // Compile module-level init statements BEFORE function bodies so that
  // closureMap is populated for module-level arrow function variables.
  // This allows function bodies (e.g. test()) to reference module-level closures.
  // (#2931) A reassigned-function live-binding global must be seeded with its
  // closure in __module_init even when the program has no other init statements,
  // so a read before the reassignment still yields the function.
  const hasLiveFuncSeeds = (ctx.liveFuncBindingGlobals?.size ?? 0) > 0;
  const hasModuleInits = ctx.moduleInitStatements.length > 0 || hasLiveFuncSeeds;
  const hasStaticInits = ctx.staticInitExprs.length > 0;
  let compiledInitFctx: FunctionContext | null = null;

  // (#2965) The module-init body is compiled TWICE (the second pass, below,
  // re-runs after top-level function bodies so call sites see the final
  // inlinable-function registry). Statement compilation mutates ctx state that
  // encodes PROGRAM ORDER — `definedPropertyFlags` ("this key was already
  // defined with these attributes") and `frozenVars`/`sealedVars`/
  // `nonExtensibleVars` ("this object is frozen from here on"). If pass 2
  // starts from pass 1's END state, every first `Object.defineProperty` at the
  // top level looks like a REDEFINE — the struct call-site then emits its
  // runtime SameValue guard comparing the field's ZERO-INIT default against
  // the descriptor value, so `defineProperty(o, "x", { value: <non-zero> })`
  // spuriously throws "Cannot redefine property" in the shipped body — and
  // defines that PRECEDE an `Object.freeze(o)` compile as if the object were
  // already frozen. Snapshot the order-sensitive state before pass 1 and
  // restore it before pass 2 so both passes compile from the same initial
  // state. (Function bodies compiled BETWEEN the passes keep seeing pass-1 end
  // state — a function called post-init observes the final integrity state;
  // that behavior is unchanged. After pass 2 the maps converge back to the
  // same end state pass 1 produced, so later consumers see no difference.)
  const propOrderStateSnapshot = {
    definedPropertyFlags: new Map(ctx.definedPropertyFlags),
    frozenVars: new Set(ctx.frozenVars),
    sealedVars: new Set(ctx.sealedVars),
    nonExtensibleVars: new Set(ctx.nonExtensibleVars),
  };
  function restorePropOrderState(): void {
    ctx.definedPropertyFlags = new Map(propOrderStateSnapshot.definedPropertyFlags);
    ctx.frozenVars = new Set(propOrderStateSnapshot.frozenVars);
    ctx.sealedVars = new Set(propOrderStateSnapshot.sealedVars);
    ctx.nonExtensibleVars = new Set(propOrderStateSnapshot.nonExtensibleVars);
  }

  function compileModuleInitBody(): FunctionContext {
    const initFctx: FunctionContext = {
      name: "__module_init",
      params: [],
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
    ctx.currentFunc = initFctx;

    // (#2931) Seed each reassigned-function live-binding global with the
    // function's closure BEFORE any user init statement runs, so a read of the
    // name before its reassignment still yields the function. Emitted via
    // `emitCachedFuncClosureAccess` (NOT the identifier read-path, which would
    // recurse into the live-binding `global.get` arm). Dedupe by global index so
    // an import alias sharing the same global is seeded once.
    if (ctx.liveFuncBindingGlobals && ctx.liveFuncBindingGlobals.size > 0) {
      const seededGlobals = new Set<number>();
      for (const liveName of ctx.liveFuncBindingGlobals) {
        const liveGlobalIdx = ctx.moduleGlobals.get(liveName);
        const liveFuncIdx = ctx.funcMap.get(liveName);
        if (liveGlobalIdx === undefined || liveFuncIdx === undefined) continue;
        if (seededGlobals.has(liveGlobalIdx)) continue;
        const closureType = emitCachedFuncClosureAccess(ctx, initFctx, liveName, liveFuncIdx);
        if (closureType === null) {
          // Could not build the closure — leave the global null-initialised.
          continue;
        }
        // Closure struct (internal ref) → externref for the externref global.
        initFctx.body.push({ op: "extern.convert_any" });
        initFctx.body.push({ op: "global.set", index: liveGlobalIdx });
        seededGlobals.add(liveGlobalIdx);
      }
    }

    // Compile static property initializers. (#1395) Each initializer is
    // scoped to its owning class — set `enclosingClassName` +
    // `isStaticContext` on initFctx for the duration of compilation so
    // `this` inside `static f = () => this`-style initializers resolves to
    // the `__class_<Name>` singleton via the static-context fallback in
    // `compileExpression(ThisKeyword)`. We toggle these per-entry rather
    // than spawning a fresh fctx because the body must accumulate into
    // a single `__module_init` and globals/locals are shared.
    for (const { globalIdx, initializer, staticBlock, className } of ctx.staticInitExprs) {
      const savedEnclosing = initFctx.enclosingClassName;
      const savedIsStatic = initFctx.isStaticContext;
      if (className !== undefined) {
        initFctx.enclosingClassName = className;
        initFctx.isStaticContext = true;
      }
      try {
        if (staticBlock) {
          // `static { ... }` block — execute its statements in source order.
          for (const s of staticBlock.body.statements) {
            compileStatement(ctx, initFctx, s);
          }
        } else if (initializer && globalIdx !== undefined) {
          const globalDef = ctx.mod.globals[localGlobalIdx(ctx, globalIdx)];
          compileExpression(ctx, initFctx, initializer, globalDef?.type);
          initFctx.body.push({ op: "global.set", index: globalIdx });
        }
      } finally {
        initFctx.enclosingClassName = savedEnclosing;
        initFctx.isStaticContext = savedIsStatic;
      }
    }

    // Compile module-level variable init statements
    for (const stmt of ctx.moduleInitStatements) {
      compileStatement(ctx, initFctx, stmt);
    }

    ctx.currentFunc = null;
    return initFctx;
  }

  if (hasModuleInits || hasStaticInits) {
    compiledInitFctx = compileModuleInitBody();
    // Expose the pending init body so fixupModuleGlobalIndices can adjust it
    // when addStringConstantGlobal is called during function body compilation.
    ctx.pendingInitBody = compiledInitFctx.body;
  }

  // Compile top-level function declarations
  for (const stmt of sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt) && (stmt.name || hasExportModifier(stmt)) && !hasDeclareModifier(stmt)) {
      const fnName = stmt.name ? stmt.name.text : "default";
      if (stmt.body) {
        const idx = funcByName.get(fnName);
        if (idx !== undefined) {
          const func = ctx.mod.functions[idx]!;
          // (#2138) IR-first: skip legacy body emission — the IR overlay owns
          // this slot. Emit an `unreachable` placeholder so the module stays
          // structurally valid between the passes; `generateModule` promotes
          // any IR failure on a skipped function to a hard compile error, so
          // the placeholder can never ship. Do NOT register as inlinable
          // (see the function doc comment).
          if (skipBodies?.has(fnName)) {
            func.body = [{ op: "unreachable" }];
            skippedNames!.push(fnName);
            continue;
          }
          try {
            compileFunctionBody(ctx, stmt, func);
            registerInlinableFunction(ctx, fnName, func);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            reportError(ctx, stmt, `Internal error compiling function '${fnName}': ${msg}`);
          }
        }
      }
    }
  }

  // Compile CJS function expression bodies (#1075)
  // These were registered in collectDeclarations from `module.exports.foo = function() {}`
  // and `exports.foo = function() {}` patterns.
  for (const stmt of sourceFile.statements) {
    if (!ts.isExpressionStatement(stmt)) continue;
    const expr = stmt.expression;
    if (!ts.isBinaryExpression(expr) || expr.operatorToken.kind !== ts.SyntaxKind.EqualsToken) continue;

    // Extract the function expression from CJS patterns
    let fnExpr: ts.FunctionExpression | undefined;
    let funcName: string | undefined;

    const left = expr.left;
    if (ts.isFunctionExpression(expr.right)) {
      // Check for module.exports = function() {} or module.exports.foo = function() {} or exports.foo = function() {}
      if (
        ts.isPropertyAccessExpression(left) &&
        ts.isIdentifier(left.expression) &&
        left.expression.text === "module" &&
        left.name.text === "exports"
      ) {
        // module.exports = function foo() {}
        fnExpr = expr.right;
        funcName = fnExpr.name?.text ?? "default";
      } else if (ts.isPropertyAccessExpression(left)) {
        // module.exports.foo or exports.foo
        const inner = left.expression;
        const isModExports =
          ts.isPropertyAccessExpression(inner) &&
          ts.isIdentifier(inner.expression) &&
          inner.expression.text === "module" &&
          inner.name.text === "exports";
        const isExports = ts.isIdentifier(inner) && inner.text === "exports";
        if (isModExports || isExports) {
          fnExpr = expr.right;
          funcName = left.name.text;
        }
      }
    }

    if (!fnExpr || !funcName || !fnExpr.body) continue;
    const idx = funcByName.get(funcName);
    if (idx === undefined) continue;
    const func = ctx.mod.functions[idx]!;
    // Skip if body already compiled (e.g., was also a FunctionDeclaration)
    if (func.body.length > 0) continue;
    try {
      compileFunctionBody(ctx, fnExpr as unknown as ts.FunctionDeclaration, func);
      registerInlinableFunction(ctx, funcName, func);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      reportError(ctx, stmt, `Internal error compiling CJS function '${funcName}': ${msg}`);
    }
  }

  if (ctx.preRegisteredBodyless?.size) {
    for (const name of Array.from(ctx.preRegisteredBodyless)) {
      const funcIdx = ctx.funcMap.get(name);
      const func = funcIdx !== undefined ? definedFuncAt(ctx, funcIdx) : undefined;
      if (func && func.body.length === 0) {
        const typeDef = ctx.mod.types[func.typeIdx];
        const returnType = typeDef?.kind === "func" ? typeDef.results[0] : undefined;
        func.body = defaultReturnInstrs(returnType);
      }
      ctx.preRegisteredBodyless.delete(name);
    }
  }

  // Recompile module init after top-level functions are compiled so call sites
  // inside module-level code can see the final inlinable-function registry.
  // The first compile above still serves early closure/setup discovery.
  if (hasModuleInits || hasStaticInits) {
    // (#2965) Reset the program-order-sensitive property state to its
    // pre-pass-1 value so this recompile does not treat pass 1's own
    // defineProperty/freeze effects as pre-existing (see snapshot above).
    restorePropOrderState();
    compiledInitFctx = compileModuleInitBody();
    ctx.pendingInitBody = compiledInitFctx.body;
  }

  // Clear pendingInitBody before injection (it lands in mod.functions after this)
  ctx.pendingInitBody = null;

  // Inject the compiled init body into a standalone `__module_init`.
  //
  // #1978: we deliberately do NOT splice the init body into a user function
  // named `main`. Module-global initializers must run exactly ONCE (at module
  // load / instantiation), but a user `main()` is a normal export the host may
  // call repeatedly — splicing the init body in re-ran the global initializers
  // on every call (top-level state reset to its initial value) and, under the
  // `main()`-calls-itself WASI convention, prepended a call to `main`'s own
  // index, causing unbounded self-recursion. `main` is just an ordinary export;
  // it gets no special init treatment. The standalone `__module_init` runs once
  // via the Wasm start section (or WASI `_start`), matching ES module semantics.
  if (compiledInitFctx && compiledInitFctx.body.length > 0) {
    ctx.mod.hasTopLevelStatements = true;

    // Create a standalone __module_init and run it automatically via the Wasm
    // start section on instantiation (#907).
    //
    // This replaces both:
    //   - the legacy `__init_done` runtime guard that injected a
    //     `if (!done) { done = 1; __module_init(); }` preamble at the start
    //     of every exported function, and
    //   - the `_start` export wrapper used for module-init-only programs.
    //
    // Wasm `start` runs once during instantiation, before the host can call
    // any export. That matches ES module semantics (top-level code runs at
    // module load) and removes the per-call guard branch from every export.
    //
    // For WASI mode, we don't set the start section here — `addWasiStartExport`
    // creates a dedicated `_start` export that wraps `__module_init`. Setting
    // both would cause init to run twice (once during instantiation, once
    // when the host calls `_start`).

    // (#2796) Diff-test-harness fidelity: when `deferTopLevelInit` is set (and
    // we are NOT in WASI mode), export `__module_init` and do NOT wire the wasm
    // `start` section to it. Top-level code that introspects WasmGC structs
    // (`for…in` / `Object.keys` on a runtime-shaped object) needs the
    // `__struct_field_names` / `__sget_*` exports, which only exist AFTER the
    // instance is constructed — so running it via the `start` section (DURING
    // instantiation, before `setExports`) enumerates zero keys. Exporting it and
    // letting the host call it after `setExports` is symmetric with the
    // standalone/WASI `_start` model and gives the diff-test HOST lane the same
    // fully-wired runtime the standalone lane has. The export's func index is
    // shifted alongside every other export by the late-import shift logic.
    const exportModuleInit = ctx.deferTopLevelInit && !ctx.wasi;
    const initTypeIdx = addFuncType(ctx, [], [], "__module_init_type");
    const initFuncIdx = ctx.numImportFuncs + ctx.mod.functions.length;
    ctx.mod.functions.push({
      name: "__module_init",
      typeIdx: initTypeIdx,
      locals: compiledInitFctx.locals,
      body: compiledInitFctx.body,
      exported: exportModuleInit,
    });
    if (exportModuleInit) {
      ctx.mod.exports.push({
        name: "__module_init",
        desc: { kind: "func", index: initFuncIdx },
      });
    }

    if (!ctx.wasi && !exportModuleInit) {
      // Use Wasm start section — init runs automatically on instantiation.
      ctx.mod.startFuncIdx = initFuncIdx;
    }
    // else: WASI path — addWasiStartExport will export `_start` calling
    // `__module_init`, and the host will invoke it explicitly. And under
    // `deferTopLevelInit` (#2796) the JS host calls the exported `__module_init`
    // directly after `setExports`.
  }

  // (#2138) Names whose legacy body was skipped under IR-first; undefined on
  // the default (no-skip) path.
  return skippedNames;
}

/**
 * Post-compilation fixup: insert extern.convert_any after struct.new when
 * the result is stored into an externref local (local.set / local.tee).
 *
 * This happens when a vec/class struct is created but the target variable
 * was typed as externref by the compiler.
 */

/** Internal field names that are not user-visible properties */
