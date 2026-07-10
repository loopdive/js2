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
import { asyncFnNeedsHostDrive } from "./async-frame.js";
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

/** Accumulated state for the single-pass collector */
interface UnifiedCollectorState {
  // -- collectConsoleImports --
  consoleNeededByMethod: Map<string, Set<"number" | "bool" | "string" | "externref">>;
  // -- collectPrimitiveMethodImports --
  primitiveNeeded: Set<string>;
  // -- collectStringLiterals --
  stringLiterals: Set<string>;
  hasTypeofExprForStrings: boolean;
  hasTaggedTemplate: boolean;
  insideComputedPropertyName: number; // depth counter
  // -- collectStringMethodImports --
  stringMethodNeeded: Set<string>;
  /** String methods called with RegExp args — need host import even in native strings mode */
  stringRegexpMethodNeeded: Set<string>;
  // -- collectMathImports --
  mathNeeded: Set<string>;
  mathNeedsToUint32: boolean;
  // -- collectParseImports --
  parseNeeded: Set<string>;
  // (#2678) HOST-mode `Date.parse(...)` / `new Date(<string>)` → host import
  // `__date_parse_host` (delegates to JS Date.parse). Registered up-front to
  // avoid the #2043 late-import shift; standalone/WASI use the native parser.
  dateParseHostNeeded: boolean;
  // -- collectURIImports --
  uriNeeded: Set<string>;
  // -- collectEscapeImports (#3063) — legacy global escape/unescape (§B.2.1/.2) --
  escapeNeeded: Set<string>;
  // -- collectStringStaticImports --
  needsFromCharCode: boolean;
  needsFromCodePoint: boolean;
  // -- collectPromiseImports --
  promiseNeeded: Set<string>;
  promiseNeedConstructor: boolean;
  promiseNeedThen2: boolean;
  // -- collectJsonImports --
  jsonNeedStringify: boolean;
  jsonNeedParse: boolean;
  // -- collectCallbackImports --
  callbackFound: boolean;
  getterCallbackFound: boolean; // Object.defineProperty accessor descriptors (#929)
  // -- collectAsyncCpsImports (#1042) --
  // A CPS-eligible async function (single tail-await, no try-across-await) needs
  // __make_callback + Promise_then2 + Promise_resolve registered UPFRONT so the
  // outer-body driver gets stable funcMap indices (the outer body is not in
  // ctx.liveBodies during emission, so a late import would not have its `call`
  // opcodes shifted — the #1384 hazard). Only set when ASYNC_CPS_ENABLED.
  asyncCpsFound: boolean;
  // (#1042 host drive) A host-drive-eligible async fn (linear multi-await /
  // try-finally-across-await, shapes the CPS lane rejects) needs the six host
  // settle-backend imports registered UPFRONT — same #1384 stable-index
  // rationale as asyncCpsFound.
  asyncHostDriveFound: boolean;
  // -- collectFunctionalArrayImports --
  funcArrayNeed1: boolean;
  funcArrayNeed2: boolean;
  // -- collectUnionImports --
  unionFound: boolean;
  // -- collectGeneratorImports --
  generatorFound: boolean;
  // -- collectIteratorImports --
  iteratorFound: boolean;
  // -- collectArrayIteratorImports --
  arrayIteratorFound: boolean;
  // -- collectForInStringLiterals --
  forInFound: boolean;
  forInLiterals: Set<string>;
  // -- collectInExprStringLiterals --
  inExprLiterals: Set<string>;
  // -- collectObjectMethodStringLiterals --
  objectMethodLiterals: Set<string>;
  objectMethodHasValues: boolean;
  // -- collectWrapperConstructors --
  wrapperFound: boolean;
  // -- collectUnknownConstructorImports --
  unknownCtorNeeded: Map<string, number>;
  // context
  sourceFile: ts.SourceFile;
}

const CONSOLE_METHODS_SET = new Set(["log", "warn", "error", "info", "debug"]);

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

export function createUnifiedCollectorState(sourceFile: ts.SourceFile): UnifiedCollectorState {
  return {
    consoleNeededByMethod: new Map(),
    primitiveNeeded: new Set(),
    stringLiterals: new Set(),
    hasTypeofExprForStrings: false,
    hasTaggedTemplate: false,
    insideComputedPropertyName: 0,
    stringMethodNeeded: new Set(),
    stringRegexpMethodNeeded: new Set(),
    mathNeeded: new Set(),
    mathNeedsToUint32: false,
    parseNeeded: new Set(),
    dateParseHostNeeded: false,
    uriNeeded: new Set(),
    escapeNeeded: new Set(),
    needsFromCharCode: false,
    needsFromCodePoint: false,
    promiseNeeded: new Set(),
    promiseNeedConstructor: false,
    promiseNeedThen2: false,
    jsonNeedStringify: false,
    jsonNeedParse: false,
    callbackFound: false,
    getterCallbackFound: false,
    asyncCpsFound: false,
    asyncHostDriveFound: false,
    funcArrayNeed1: false,
    funcArrayNeed2: false,
    unionFound: false,
    generatorFound: false,
    iteratorFound: false,
    arrayIteratorFound: false,
    forInFound: false,
    forInLiterals: new Set(),
    inExprLiterals: new Set(),
    objectMethodLiterals: new Set(),
    objectMethodHasValues: false,
    wrapperFound: false,
    unknownCtorNeeded: new Map(),
    sourceFile,
  };
}

/** Single-pass visitor called on every AST node */
export function unifiedVisitNode(ctx: CodegenContext, state: UnifiedCollectorState, node: ts.Node): void {
  // ── collectStringLiterals (skip computed property names) ──
  if (state.insideComputedPropertyName === 0) {
    if (ts.isStringLiteral(node)) {
      state.stringLiterals.add(node.text);
    }
    if (ts.isNoSubstitutionTemplateLiteral(node)) {
      state.stringLiterals.add(node.text);
    }
    if (ts.isTemplateExpression(node)) {
      state.stringLiterals.add(node.head.text); // include empty strings
      for (const span of node.templateSpans) {
        state.stringLiterals.add(span.literal.text); // include empty strings
      }
    }
    if (ts.isTaggedTemplateExpression(node)) {
      state.hasTaggedTemplate = true;
      if (ts.isNoSubstitutionTemplateLiteral(node.template)) {
        state.stringLiterals.add(node.template.text);
        const rawText = (node.template as any).rawText;
        if (rawText !== undefined) state.stringLiterals.add(rawText);
      } else if (ts.isTemplateExpression(node.template)) {
        state.stringLiterals.add(node.template.head.text);
        const headRaw = (node.template.head as any).rawText;
        if (headRaw !== undefined) state.stringLiterals.add(headRaw);
        for (const span of node.template.templateSpans) {
          state.stringLiterals.add(span.literal.text);
          const spanRaw = (span.literal as any).rawText;
          if (spanRaw !== undefined) state.stringLiterals.add(spanRaw);
        }
      }
    }
    if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) {
      const { pattern, flags } = parseRegExpLiteral(node.getText());
      state.stringLiterals.add(pattern);
      if (flags) state.stringLiterals.add(flags);
    }
    if (ts.isTypeOfExpression(node)) {
      state.hasTypeofExprForStrings = true;
    }
    if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword && node.name.text === "meta") {
      state.stringLiterals.add("module.wasm");
      state.stringLiterals.add("[object Object]");
    }
  }

  // ── collectConsoleImports ──
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "console"
  ) {
    const method = node.expression.name.text;
    if (CONSOLE_METHODS_SET.has(method)) {
      if (!state.consoleNeededByMethod.has(method)) state.consoleNeededByMethod.set(method, new Set());
      const needed = state.consoleNeededByMethod.get(method)!;
      for (const arg of node.arguments) {
        const argType = ctx.checker.getTypeAtLocation(arg);
        if (isStringType(argType)) {
          needed.add("string");
        } else if (isBooleanType(argType)) {
          needed.add("bool");
        } else if (isNumberType(argType)) {
          needed.add("number");
        } else {
          needed.add("externref");
        }
      }
    }
  }

  // ── (#2972) string element access with a computed index ──
  // The IR lowers a proven-in-bounds `s[i]` (string receiver, non-literal
  // index) through the SAME charAt machinery as `s.charAt(i)` — but the
  // element-access syntax never mentions `.charAt`, so the method-syntax
  // scan below can't see it and the `string_charAt` env import would be
  // missing at IR lower time (post-claim demote flag-off; a hard error
  // under JS2WASM_IR_FIRST — the 14-test #2972 class). Pre-register the
  // import whenever the shape appears with a string-typed receiver. If the
  // IR ends up not claiming the function the import is simply unused (and
  // eliminated by eliminateDeadImports), so over-registration is harmless.
  // NOTE for #1930 (TypeOracle): this getTypeAtLocation site is a
  // query-only fact read — migrate to `oracle.typeOf` when the facade lands.
  if (
    ts.isElementAccessExpression(node) &&
    !ts.isStringLiteralLike(node.argumentExpression) &&
    isStringType(ctx.checker.getTypeAtLocation(node.expression))
  ) {
    state.stringMethodNeeded.add("charAt");
  }

  // ── collectPrimitiveMethodImports ──
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    const prop = node.expression;
    const receiverType = ctx.checker.getTypeAtLocation(prop.expression);
    const methodName = prop.name.text;
    // #1215: Array<number>.join() / Array<number>.toString() must coerce each
    // element to a string before concatenation. Without `number_toString` registered,
    // compileArrayJoin silently drops the f64→externref conversion and emits a Wasm
    // module that fails validation with "local.set[0] expected externref, found
    // array.get of type f64". Register the import here so the codegen path can
    // emit the call.
    if (methodName === "join" || methodName === "toString") {
      const elemType = receiverType.getNumberIndexType();
      if (elemType && (isNumberType(elemType) || isBooleanType(elemType) || isBigIntType(elemType))) {
        state.primitiveNeeded.add("number_toString");
      }
    }
    // #1993 — the default (no-comparator) Array.prototype.sort compares by
    // ToString (§23.1.3.30). Pre-register `string_compare` (and, for numeric
    // arrays, `number_toString`) here so the codegen path can emit the
    // stringify+compare without a late module-function shift.
    if (methodName === "sort") {
      const noComparator =
        node.arguments.length === 0 ||
        node.arguments[0]!.kind === ts.SyntaxKind.UndefinedKeyword ||
        (ts.isIdentifier(node.arguments[0]!) && (node.arguments[0] as ts.Identifier).text === "undefined");
      if (noComparator) {
        const elemType = receiverType.getNumberIndexType();
        if (elemType && (isNumberType(elemType) || isBooleanType(elemType))) {
          state.primitiveNeeded.add("number_toString");
          state.primitiveNeeded.add("string_compare");
        } else if (elemType && isStringType(elemType)) {
          state.primitiveNeeded.add("string_compare");
        }
      }
    }
    if (isNumberType(receiverType) && methodName === "toString") {
      // #1321: toString(radix) needs a 2-arg host import so the radix is
      // actually used. The 1-arg `number_toString` only handles default base 10.
      if (node.arguments.length > 0) {
        state.primitiveNeeded.add("number_toString_radix");
      } else {
        state.primitiveNeeded.add("number_toString");
      }
    }
    // (#1644 Slice D) BigInt.prototype.toString — bigint-typed receiver routes
    // to bigint_toString / bigint_toString_radix (i64 → externref). Without
    // this registration the property-access path falls through and returns null.
    if (isBigIntType(receiverType) && methodName === "toString") {
      state.primitiveNeeded.add("bigint_toString");
      if (node.arguments.length > 0) {
        state.primitiveNeeded.add("bigint_toString_radix");
      }
    }
    // (#2160) `Number.prototype.toLocaleString()` with no arguments, STANDALONE/
    // WASI only. With no ECMA-402 (Intl) implementation, §21.1.3.4 specifies the
    // result is the same as `Number.prototype.toString()` (base 10) — the
    // implementation-defined locale formatting reduces to plain ToString. In
    // standalone/WASI there is no host `__extern_toLocaleString`, so register the
    // native `number_toString` helper and route the call to it (see the matching
    // codegen arm). Host (gc) mode keeps the `__extern_toLocaleString` import,
    // which gives real Intl grouping (`(1234).toLocaleString() === "1,234"`), so
    // this registration is gated off there. The 0-arg guard keeps a
    // locale-argument form (which would need real Intl) on the host fallback.
    if (
      (ctx.standalone || ctx.wasi) &&
      isNumberType(receiverType) &&
      methodName === "toLocaleString" &&
      node.arguments.length === 0
    ) {
      state.primitiveNeeded.add("number_toString");
    }
    // (#2160 number-wrapper) Standalone `new Number(x).<fmt>()` recovers the
    // wrapper's f64 (via __to_primitive in calls.ts) and dispatches to the SAME
    // native `number_*` helpers as a primitive receiver. The wrapper type is
    // `TypeFlags.Object` (symbol "Number"), not `isNumberType`, so it must be
    // recognized here — this scan drives `emitNativeNumberFormat` in standalone —
    // or the helper is never emitted and the call site returns null. Gated on
    // standalone (the recovery path); host/WASI keep their existing routing.
    const isNumFmtRecv = isNumberType(receiverType) || (ctx.standalone && isNumberWrapperType(receiverType));
    if (isNumFmtRecv && methodName === "toFixed") {
      state.primitiveNeeded.add("number_toFixed");
    }
    if (isNumFmtRecv && methodName === "toPrecision") {
      state.primitiveNeeded.add("number_toPrecision");
    }
    if (isNumFmtRecv && methodName === "toExponential") {
      state.primitiveNeeded.add("number_toExponential");
    }
    if (
      ctx.standalone &&
      isNumberWrapperType(receiverType) &&
      (methodName === "toString" || methodName === "toLocaleString")
    ) {
      state.primitiveNeeded.add("number_toString");
    }
    if (ctx.standalone && isNumberWrapperType(receiverType) && methodName === "toString") {
      // radix form needs the 2-arg helper
      state.primitiveNeeded.add("number_toString_radix");
    }
    // ── collectStringMethodImports (also uses call+propertyAccess) ──
    if (isStringType(receiverType) && Object.prototype.hasOwnProperty.call(STRING_METHODS, methodName)) {
      state.stringMethodNeeded.add(methodName);
      // Track if the method is called with a non-string arg (RegExp or
      // custom object with Symbol.replace/Symbol.match/etc). For those we
      // need the host import in addition to any native helper because the
      // native helpers only handle string search values and we need JS
      // semantics for @@replace / @@match / @@search / @@split dispatch
      // (#1443).
      if (
        (methodName === "replace" ||
          methodName === "replaceAll" ||
          methodName === "split" ||
          methodName === "match" ||
          methodName === "search") &&
        ts.isCallExpression(node) &&
        node.arguments.length > 0
      ) {
        const argType = ctx.checker.getTypeAtLocation(node.arguments[0]!);
        const isStringLike = (t: ts.Type): boolean => {
          if ((t.flags & ts.TypeFlags.String) !== 0) return true;
          if ((t.flags & ts.TypeFlags.StringLiteral) !== 0) return true;
          if ((t.flags & ts.TypeFlags.Object) !== 0 && t.getSymbol()?.getName() === "String") return true;
          return false;
        };
        let needsHost = false;
        if ((argType.flags & ts.TypeFlags.Union) !== 0) {
          const union = argType as ts.UnionType;
          needsHost = !union.types.every(isStringLike);
        } else {
          needsHost = !isStringLike(argType);
        }
        if (needsHost) {
          state.stringRegexpMethodNeeded.add(methodName);
        }
      }
    }
  }
  // (#2029 family C) Element-access spelling of the number-format methods —
  // `1["toFixed"](5)`, `5["toString"](2)` (test262
  // property-accessors/S11.2.1_A3_T2). The dot-form scan above never sees
  // these, so the native helpers were not registered; the codegen
  // element-access arm (calls.ts) then found `funcMap.get("number_toFixed")`
  // undefined and fell through past its already-pushed receiver+argument into
  // the generic dynamic fallback — a dirty stack whose ref.null receiver threw
  // "Cannot access property on null or undefined" at runtime standalone.
  // Register the same helpers for a statically-resolvable string key.
  if (
    ts.isCallExpression(node) &&
    ts.isElementAccessExpression(node.expression) &&
    ts.isStringLiteral(node.expression.argumentExpression)
  ) {
    const elemMethodName = node.expression.argumentExpression.text;
    // Oracle-first (#1930): a primitive-number receiver reports `"number"`;
    // a `new Number(x)` wrapper reports its declared symbol name "Number"
    // (mirrors `isNumberWrapperType`'s Object+symbol check).
    const elemRecvExpr = node.expression.expression;
    const isElemNumFmtRecv =
      ctx.oracle.staticJsTypeOf(elemRecvExpr) === "number" ||
      (ctx.standalone && ctx.oracle.declaredNameOf(elemRecvExpr) === "Number");
    if (isElemNumFmtRecv) {
      if (elemMethodName === "toFixed") {
        state.primitiveNeeded.add("number_toFixed");
      } else if (elemMethodName === "toPrecision") {
        state.primitiveNeeded.add("number_toPrecision");
        // 0-arg toPrecision routes to plain toString (see the codegen arm).
        state.primitiveNeeded.add("number_toString");
      } else if (elemMethodName === "toExponential") {
        state.primitiveNeeded.add("number_toExponential");
      } else if (elemMethodName === "toString") {
        if (node.arguments.length > 0) {
          state.primitiveNeeded.add("number_toString_radix");
        } else {
          state.primitiveNeeded.add("number_toString");
        }
      }
    }
  }
  // Template expressions with number/boolean/bigint substitutions need number_toString
  if (ts.isTemplateExpression(node)) {
    for (const span of node.templateSpans) {
      const spanType = ctx.checker.getTypeAtLocation(span.expression);
      // An `any`/`unknown`-typed span (common in .js files / untyped params,
      // where the checker can't narrow but codegen still lowers the value as a
      // numeric f64/i32/i64) must also pre-register number_toString. Otherwise
      // the checker-based pre-pass and codegen's value-type resolution diverge:
      // codegen reaches the numeric substitution branch with no helper to call
      // and hard-errors ("Template literal numeric substitution requires
      // number_toString"), aborting compilation. Registering the helper is
      // harmless when the span turns out non-numeric — codegen only calls it on
      // the numeric branch.
      const isAnyOrUnknown = (spanType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
      if (isNumberType(spanType) || isBooleanType(spanType) || isBigIntType(spanType) || isAnyOrUnknown) {
        state.primitiveNeeded.add("number_toString");
      }
    }
  }
  // String(expr) calls need number_toString
  if (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "String" &&
    node.arguments.length >= 1
  ) {
    const argType = ctx.checker.getTypeAtLocation(node.arguments[0]!);
    if (isNumberType(argType) || !isStringType(argType)) {
      state.primitiveNeeded.add("number_toString");
    }
  }
  // String + non-string concatenation
  if (
    ts.isBinaryExpression(node) &&
    (node.operatorToken.kind === ts.SyntaxKind.PlusToken || node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken)
  ) {
    const leftType = ctx.checker.getTypeAtLocation(node.left);
    const rightType = ctx.checker.getTypeAtLocation(node.right);
    if (isStringType(leftType) && !isStringType(rightType)) {
      state.primitiveNeeded.add("number_toString");
    }
    if (!isStringType(leftType) && isStringType(rightType)) {
      state.primitiveNeeded.add("number_toString");
    }
    if (
      node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken &&
      (leftType.flags & ts.TypeFlags.Any) !== 0 &&
      !isStringType(rightType)
    ) {
      state.primitiveNeeded.add("number_toString");
    }
  }
  // String comparison operators
  if (
    ts.isBinaryExpression(node) &&
    (node.operatorToken.kind === ts.SyntaxKind.LessThanToken ||
      node.operatorToken.kind === ts.SyntaxKind.LessThanEqualsToken ||
      node.operatorToken.kind === ts.SyntaxKind.GreaterThanToken ||
      node.operatorToken.kind === ts.SyntaxKind.GreaterThanEqualsToken)
  ) {
    const leftType = ctx.checker.getTypeAtLocation(node.left);
    if (isStringType(leftType)) {
      state.primitiveNeeded.add("string_compare");
    }
  }

  // ── collectMathImports ──
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "Math"
  ) {
    const method = node.expression.name.text;
    if (MATH_HOST_METHODS_1ARG.has(method) || MATH_HOST_METHODS_2ARG.has(method) || method === "random") {
      state.mathNeeded.add(method);
    }
    if (method === "clz32" || method === "imul") {
      state.mathNeedsToUint32 = true;
    }
  }
  if (
    ts.isBinaryExpression(node) &&
    (node.operatorToken.kind === ts.SyntaxKind.AsteriskAsteriskToken ||
      node.operatorToken.kind === ts.SyntaxKind.AsteriskAsteriskEqualsToken)
  ) {
    state.mathNeeded.add("pow");
  }

  // ── collectDateParseHostImports (#2678) ──
  // HOST mode only — standalone/WASI use the native `__date_parse` emitted at
  // the call site. `Date.parse(...)` (member call) and `new Date(<string>)`
  // both delegate to the host JS `Date.parse` via `__date_parse_host`.
  if (!ctx.standalone && !ctx.wasi) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "Date" &&
      node.expression.name.text === "parse" &&
      node.arguments.length >= 1
    ) {
      state.dateParseHostNeeded = true;
    }
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "Date" &&
      node.arguments &&
      node.arguments.length === 1
    ) {
      try {
        const argType = ctx.checker.getTypeAtLocation(node.arguments[0]!);
        if (argType.flags & ts.TypeFlags.StringLike || isStringType(argType)) {
          state.dateParseHostNeeded = true;
        }
      } catch {
        // type resolution may fail — skip (a runtime ToString path still applies)
      }
    }
  }

  // ── collectParseImports ──
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
    let name = node.expression.text;
    // Resolve aliases like `var freeParseInt = parseInt; freeParseInt(...)` (#1109)
    if (name !== "parseInt" && name !== "parseFloat") {
      const sym = ctx.checker.getSymbolAtLocation(node.expression);
      const decl = sym?.valueDeclaration;
      if (decl && ts.isVariableDeclaration(decl) && decl.initializer && ts.isIdentifier(decl.initializer)) {
        const initName = decl.initializer.text;
        if (initName === "parseInt" || initName === "parseFloat") {
          name = initName;
        }
      }
    }
    if (name === "parseInt" || name === "parseFloat") {
      state.parseNeeded.add(name);
      // (#2652) In standalone / WASI the native parse helpers take a string ref;
      // a NON-string primitive arg (`parseInt(true)` / `parseInt(-1)`) must be
      // run through ToString at the call site (emitToString) BEFORE the call.
      // Pre-register the helpers/literals that lowering needs so no late
      // module-function shift is forced mid-body:
      //   numeric arg  → `number_toString`
      //   boolean arg  → "true"/"false" string literals (emitBoolToString)
      //   void arg     → "undefined" literal
      if ((ctx.standalone || ctx.wasi) && node.arguments.length >= 1) {
        const arg0 = node.arguments[0]!;
        const arg0Type = ctx.checker.getTypeAtLocation(arg0);
        const isStr = isStringType(arg0Type);
        if (!isStr) {
          if (isBooleanType(arg0Type)) {
            state.stringLiterals.add("true");
            state.stringLiterals.add("false");
          } else if (isNumberType(arg0Type)) {
            state.primitiveNeeded.add("number_toString");
          } else if (arg0Type.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) {
            state.stringLiterals.add("undefined");
          } else if (arg0Type.flags & ts.TypeFlags.Null) {
            state.stringLiterals.add("null");
          }
        }
      }
    }
    if (
      name === "decodeURI" ||
      name === "decodeURIComponent" ||
      name === "encodeURI" ||
      name === "encodeURIComponent"
    ) {
      state.uriNeeded.add(name);
    }
    // (#3063) Legacy `escape` / `unescape` (§B.2.1 / §B.2.2) — pure string
    // transforms. JS-host mode routes to the native JS globals via an env host
    // import (registered in the emit phase, gated to host mode so standalone
    // never leaks an unsatisfiable import). A pure-Wasm standalone lowering is a
    // follow-up (mirrors the uri-encoding-native.ts machinery).
    if (name === "escape" || name === "unescape") {
      state.escapeNeeded.add(name);
    }
    if (name === "Number") {
      state.parseNeeded.add("parseFloat");
      // Under native strings (standalone/WASI) a `Number(string)` argument is a
      // WasmGC string ref, not an externref the host `__unbox_number` can read.
      // Emit the pure-Wasm §7.1.4.1 StringToNumber helper so the call site can
      // route the string ref through it instead of the no-op host path (#1688).
      if (ctx.nativeStrings) state.parseNeeded.add("__str_to_number");
    }
  }
  // #2160 — `Number.parseInt` / `Number.parseFloat` (§21.1.2.12-13) are the same
  // functions as the global `parseInt` / `parseFloat` and lower through the same
  // call-site routing (calls.ts), which reads `ctx.funcMap.get("parseInt"/"parseFloat")`.
  // The collector above only saw the *bare* identifier form, so the
  // namespaced form never registered the import / native scanner and standalone
  // fell through to a `__get_builtin` compile error. Detect the property-access
  // form here so the same parse helper is registered.
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "Number" &&
    (node.expression.name.text === "parseInt" || node.expression.name.text === "parseFloat")
  ) {
    state.parseNeeded.add(node.expression.name.text);
  }
  if (
    ts.isPrefixUnaryExpression(node) &&
    node.operator === ts.SyntaxKind.PlusToken &&
    !ts.isStringLiteral(node.operand) &&
    !ts.isNoSubstitutionTemplateLiteral(node.operand)
  ) {
    const operandType = ctx.checker.getTypeAtLocation(node.operand);
    if (operandType.flags & ts.TypeFlags.StringLike) {
      state.parseNeeded.add(ctx.nativeStrings ? "__str_to_number" : "parseFloat");
    }
  }
  if (
    ts.isBinaryExpression(node) &&
    (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken ||
      node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsToken)
  ) {
    try {
      const leftType = ctx.checker.getTypeAtLocation(node.left);
      const rightType = ctx.checker.getTypeAtLocation(node.right);
      const leftIsStr = isStringType(leftType);
      const rightIsStr = isStringType(rightType);
      const leftIsNumOrBool = isNumberType(leftType) || isBooleanType(leftType);
      const rightIsNumOrBool = isNumberType(rightType) || isBooleanType(rightType);
      if ((leftIsStr && rightIsNumOrBool) || (rightIsStr && leftIsNumOrBool)) {
        state.parseNeeded.add("parseFloat");
      }
    } catch {
      // Type resolution may fail for some nodes
    }
  }
  if (ts.isBinaryExpression(node)) {
    const opKind = node.operatorToken.kind;
    const isArithOrBitwise =
      opKind === ts.SyntaxKind.MinusToken ||
      opKind === ts.SyntaxKind.AsteriskToken ||
      opKind === ts.SyntaxKind.AsteriskAsteriskToken ||
      opKind === ts.SyntaxKind.SlashToken ||
      opKind === ts.SyntaxKind.PercentToken ||
      opKind === ts.SyntaxKind.AmpersandToken ||
      opKind === ts.SyntaxKind.BarToken ||
      opKind === ts.SyntaxKind.CaretToken ||
      opKind === ts.SyntaxKind.LessThanLessThanToken ||
      opKind === ts.SyntaxKind.GreaterThanGreaterThanToken ||
      opKind === ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken;
    if (isArithOrBitwise) {
      try {
        const leftType = ctx.checker.getTypeAtLocation(node.left);
        const rightType = ctx.checker.getTypeAtLocation(node.right);
        if (isStringType(leftType) || isStringType(rightType)) {
          state.parseNeeded.add(ctx.nativeStrings ? "__str_to_number" : "parseFloat");
        }
      } catch {
        // Type resolution may fail
      }
    }
  }

  // ── collectStringStaticImports (String.fromCharCode / String.fromCodePoint) ──
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "String"
  ) {
    if (node.expression.name.text === "fromCharCode") state.needsFromCharCode = true;
    if (node.expression.name.text === "fromCodePoint") state.needsFromCodePoint = true;
  }

  // ── collectPromiseImports ──
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "Promise"
  ) {
    const method = node.expression.name.text;
    if (
      method === "all" ||
      method === "race" ||
      method === "resolve" ||
      method === "reject" ||
      method === "allSettled" ||
      method === "any"
    ) {
      state.promiseNeeded.add(method);
    }
  }
  // NOTE: Promise instance methods (.then/.catch/.finally) are NOT detected here.
  // Pre-registering them adds func types that shift struct type indices, breaking
  // non-Promise code in the same module. They're handled at codegen time instead.
  if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Promise") {
    state.promiseNeedConstructor = true;
  }

  // ── collectJsonImports ──
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "JSON"
  ) {
    const method = node.expression.name.text;
    if (method === "stringify") {
      state.jsonNeedStringify = true;
      const arg = node.arguments[0];
      if (arg) {
        const argType = ctx.checker.getTypeAtLocation(arg);
        if (isNumberType(argType)) {
          state.primitiveNeeded.add("number_toString");
        }
      }
    }
    if (method === "parse") state.jsonNeedParse = true;
  }

  // ── collectCallbackImports ──
  if (!state.callbackFound) {
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      state.callbackFound = true;
    }
  }

  // ── collectAsyncCpsImports (#1042) ──
  // Detect a CPS-eligible async function so the host imports the driver emits
  // (__make_callback / Promise_then2 / Promise_resolve) are registered upfront
  // with STABLE funcMap indices. Mirrors the activation gate exactly (single
  // tail-await canonical shape, no try-across-await, JS-host).
  //
  // (#2957 phase 2) Widened to async ARROWS and FUNCTION EXPRESSIONS: those
  // shapes now activate the CPS machine too (via `closures.ts`), so their host
  // imports must likewise be pre-registered. If they were not, a module whose
  // only async fns are arrows would reach `emitAsyncStateMachine` with the
  // imports missing → it bails and the arrow silently falls back to the legacy
  // sync pass-through. Method shapes remain phase 3.
  if (
    ASYNC_CPS_ENABLED &&
    (!state.asyncCpsFound || !state.asyncHostDriveFound) &&
    !ctx.wasi &&
    !ctx.standalone &&
    (ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
    node.body !== undefined &&
    hasAsyncModifier(node)
  ) {
    const plan = analyzeAsyncBody(ctx, node);
    // Mirror the function-body.ts activation gate EXACTLY (#1936
    // `asyncFnNeedsCps`): genuine suspension + single canonical tail-await
    // shape. Pre-registering imports for a fn that won't actually be CPS-lowered
    // would add unused imports (harmless) but a mismatch the other way would
    // re-introduce the late-import shift hazard, so keep the predicates identical.
    if (!state.asyncCpsFound && asyncFnNeedsCps(node, plan)) {
      state.asyncCpsFound = true;
    }
    // (#1042 host drive) Same discipline for the host settle backend of the
    // #2906 N-state resume machine: mirror `asyncFnNeedsHostDrive` exactly so
    // its six imports (__make_callback / Promise_resolve / Promise_then2 /
    // Promise_new_pending / Promise_settle_resolve / Promise_settle_reject)
    // carry stable import indices.
    if (!state.asyncHostDriveFound && asyncFnNeedsHostDrive(ctx, node, plan)) {
      state.asyncHostDriveFound = true;
    }
  }
  // (#1239) Object literals carrying get/set accessor declarations also
  // route through `__make_getter_callback` via compileObjectLiteralWithAccessors.
  //
  // (#1433) Same path is used for `[Symbol.dispose]` / `[Symbol.asyncDispose]`
  // methods so the disposer is installed as a real JS function under the
  // matching Symbol property.
  if (!state.getterCallbackFound && ts.isObjectLiteralExpression(node)) {
    for (const p of node.properties) {
      if (ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p)) {
        state.getterCallbackFound = true;
        break;
      }
      if (ts.isMethodDeclaration(p) && ts.isComputedPropertyName(p.name)) {
        const inner = p.name.expression;
        // (#1433) Symbol.dispose / asyncDispose computed methods.
        if (
          ts.isPropertyAccessExpression(inner) &&
          ts.isIdentifier(inner.expression) &&
          inner.expression.text === "Symbol" &&
          (inner.name.text === "dispose" || inner.name.text === "asyncDispose")
        ) {
          state.getterCallbackFound = true;
          break;
        }
        // (#3048) A non-plain-literal computed method key routes through the
        // host plain-object method arms in literals.ts — the well-known-`Symbol`
        // arm (`{ [Symbol.iterator]() {} }`) and the runtime-key arm
        // (`{ [ID(2)]() {} }`, `{ [k]() {} }`) — both of which install the method
        // value via the `__make_getter_callback` bridge. Only a plain
        // numeric/string-literal key (`{ [1]() {} }`, `{ ["x"]() {} }`) resolves
        // to a static method name and takes the struct/string path (no bridge),
        // so it needs no registration. The pre-pass previously registered the
        // bridge only for the `dispose`/`asyncDispose` arm above, so every other
        // well-known-symbol / runtime computed method missed it → hard CE
        // "Missing __make_getter_callback import" (#1027 resurgence). Host/GC
        // only: standalone/WASI compile the method as a host-free closure (#2194)
        // and must not declare the unsatisfiable `env::` bridge import.
        const isPlainLiteralKey = ts.isNumericLiteral(inner) || ts.isStringLiteralLike(inner);
        if (!isPlainLiteralKey && !ctx.standalone && !ctx.wasi) {
          state.getterCallbackFound = true;
          break;
        }
      }
    }
  }
  // ── getterCallbackFound: Object.defineProperty / Reflect.defineProperty with accessor descriptor (#929) ──
  // Also covers Object.defineProperties(obj, { p1: desc1, p2: desc2, ... }) (#1027)
  if (!state.getterCallbackFound && ts.isCallExpression(node)) {
    if (
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.name) &&
      ts.isIdentifier(node.expression.expression) &&
      (node.expression.expression.text === "Object" || node.expression.expression.text === "Reflect")
    ) {
      const methodName = node.expression.name.text;
      if (methodName === "defineProperty" && node.arguments.length >= 3) {
        if (isAccessorDescriptor(node.arguments[2]!)) {
          state.getterCallbackFound = true;
        }
      } else if (methodName === "defineProperties" && node.arguments.length >= 2) {
        const propsArg = node.arguments[1]!;
        if (ts.isObjectLiteralExpression(propsArg)) {
          for (const prop of propsArg.properties) {
            if (ts.isPropertyAssignment(prop) && isAccessorDescriptor(prop.initializer)) {
              state.getterCallbackFound = true;
              break;
            }
          }
        }
      }
    }
  }
  // ── getterCallbackFound: JSON.parse(text, reviver) reviver that reads `this` (#3046) ──
  // §25.5.1.1 InternalizeJSONProperty invokes the reviver with the holder as
  // `this`. A reviver that touches `this` must route through the
  // `this`-forwarding `__make_getter_callback` bridge (see
  // `compileArrowFunction` in closures.ts). Register the import here so the
  // needsThis emit at the call site has it available.
  if (!state.getterCallbackFound && ts.isCallExpression(node)) {
    const callee = node.expression;
    if (
      ts.isPropertyAccessExpression(callee) &&
      ts.isIdentifier(callee.expression) &&
      callee.expression.text === "JSON" &&
      callee.name.text === "parse" &&
      node.arguments.length >= 2
    ) {
      const reviver = node.arguments[1]!;
      if ((ts.isFunctionExpression(reviver) || ts.isArrowFunction(reviver)) && functionBodyReferencesThis(reviver)) {
        state.getterCallbackFound = true;
      }
    }
  }

  // ── collectFunctionalArrayImports ──
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    const method = node.expression.name.text;
    if (FUNCTIONAL_ARRAY_METHODS.has(method)) {
      if (method === "reduce" || method === "reduceRight") {
        state.funcArrayNeed2 = true;
      } else {
        state.funcArrayNeed1 = true;
      }
    }
    if (method === "call" && ts.isPropertyAccessExpression(node.expression.expression)) {
      const innerMethod = node.expression.expression.name.text;
      if (FUNCTIONAL_ARRAY_METHODS.has(innerMethod)) {
        if (innerMethod === "reduce" || innerMethod === "reduceRight") {
          state.funcArrayNeed2 = true;
        } else {
          state.funcArrayNeed1 = true;
        }
      }
    }
  }

  // ── collectUnionImports ──
  if (!state.unionFound) {
    if (ts.isFunctionDeclaration(node) && node.parameters) {
      for (const param of node.parameters) {
        const paramType = ctx.checker.getTypeAtLocation(param);
        if (isHeterogeneousUnion(paramType, ctx.checker)) {
          state.unionFound = true;
          break;
        }
      }
    }
    if (!state.unionFound && ts.isVariableDeclaration(node) && node.type) {
      const varType = ctx.checker.getTypeAtLocation(node);
      if (isHeterogeneousUnion(varType, ctx.checker)) {
        state.unionFound = true;
      }
    }
    if (!state.unionFound && ts.isTypeOfExpression(node)) {
      state.unionFound = true;
    }
    if (
      !state.unionFound &&
      ts.isFunctionDeclaration(node) &&
      node.asteriskToken &&
      node.body &&
      !hasDeclareModifier(node) &&
      !((ctx.standalone || ctx.wasi) && isNativeGeneratorCandidate(ctx, node))
    ) {
      state.unionFound = true;
    }
    if (!state.unionFound && ts.isFunctionExpression(node) && node.asteriskToken) {
      state.unionFound = true;
    }
    if (!state.unionFound && ts.isMethodDeclaration(node) && node.asteriskToken && node.body) {
      state.unionFound = true;
    }
    if (!state.unionFound && ts.isForOfStatement(node)) {
      const exprType = ctx.checker.getTypeAtLocation(node.expression);
      const sym = (exprType as ts.TypeReference).symbol ?? (exprType as ts.Type).symbol;
      if (sym?.name !== "Array") {
        state.unionFound = true;
      }
    }
  }

  // ── collectGeneratorImports ──
  if (!state.generatorFound) {
    if (ts.isFunctionDeclaration(node) && node.asteriskToken && node.body && !hasDeclareModifier(node)) {
      state.generatorFound = true;
    }
    if (!state.generatorFound && ts.isFunctionExpression(node) && node.asteriskToken) {
      state.generatorFound = true;
    }
    if (!state.generatorFound && ts.isMethodDeclaration(node) && node.asteriskToken && node.body) {
      state.generatorFound = true;
    }
  }

  // (#2980) Flag any async generator for the widened-standalone Promise-lane
  // fallback (see `moduleHasAsyncGen` in context/types.ts). Pre-body so a
  // `Promise.reject` INSIDE the gen sees it.
  if (
    !ctx.moduleHasAsyncGen &&
    (node as ts.Node & { asteriskToken?: ts.Node }).asteriskToken !== undefined &&
    (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isMethodDeclaration(node)) &&
    node.body !== undefined &&
    hasAsyncModifier(node)
  ) {
    ctx.moduleHasAsyncGen = true;
  }

  // ── collectArrayIteratorImports ──
  if (!state.arrayIteratorFound && ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    const methodName = node.expression.name.text;
    if (methodName === "entries" || methodName === "keys" || methodName === "values") {
      const recvType = ctx.checker.getTypeAtLocation(node.expression.expression);
      const sym = (recvType as ts.TypeReference).symbol ?? (recvType as ts.Type).symbol;
      if (sym?.name === "Array") {
        state.arrayIteratorFound = true;
      }
    }
  }

  // ── collectIteratorImports ──
  if (!state.iteratorFound && ts.isForOfStatement(node)) {
    const exprType = ctx.checker.getTypeAtLocation(node.expression);
    const sym = (exprType as ts.TypeReference).symbol ?? (exprType as ts.Type).symbol;
    if (sym?.name !== "Array") {
      if (ctx.nativeStrings && ctx.anyStrTypeIdx >= 0 && isStringType(exprType)) {
        // In fast mode, strings are iterated natively
      } else {
        state.iteratorFound = true;
      }
    }
  }

  // ── collectForInStringLiterals ──
  if (ts.isForInStatement(node)) {
    state.forInFound = true;
    const exprType = ctx.checker.getTypeAtLocation(node.expression);
    const props = exprType.getProperties();
    for (const prop of props) {
      if (!ctx.stringGlobalMap.has(prop.name)) state.forInLiterals.add(prop.name);
    }
  }

  // ── collectInExprStringLiterals ──
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.InKeyword) {
    if (!ts.isStringLiteral(node.left) && !ts.isNumericLiteral(node.left)) {
      const rightType = ctx.checker.getTypeAtLocation(node.right);
      const props = rightType.getProperties();
      for (const prop of props) {
        if (!ctx.stringGlobalMap.has(prop.name)) state.inExprLiterals.add(prop.name);
      }
    }
  }

  // ── collectObjectMethodStringLiterals ──
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "Object" &&
    (node.expression.name.text === "keys" ||
      node.expression.name.text === "values" ||
      node.expression.name.text === "entries") &&
    node.arguments.length === 1
  ) {
    if (node.expression.name.text === "values" || node.expression.name.text === "entries")
      state.objectMethodHasValues = true;
    const argType = ctx.checker.getTypeAtLocation(node.arguments[0]!);
    const props = argType.getProperties();
    for (const prop of props) {
      if (!ctx.stringLiteralMap.has(prop.name)) state.objectMethodLiterals.add(prop.name);
    }
  }

  // ── collectWrapperConstructors ──
  if (!state.wrapperFound && ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
    const name = node.expression.text;
    if (name === "Number" || name === "String" || name === "Boolean") {
      state.wrapperFound = true;
    }
  }

  // ── collectUnknownConstructorImports ──
  if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
    const name = node.expression.text;
    if (!KNOWN_CONSTRUCTORS.has(name)) {
      const sym = ctx.checker.getSymbolAtLocation(node.expression);
      const decls = sym?.getDeclarations() ?? [];
      const isLocalClass = decls.some((d) => {
        if (ts.isClassDeclaration(d) || ts.isClassExpression(d)) return d.getSourceFile() === state.sourceFile;
        if (ts.isVariableDeclaration(d) && d.initializer && ts.isClassExpression(d.initializer))
          return d.getSourceFile() === state.sourceFile;
        return false;
      });
      const isExtern = ctx.externClasses.has(name);
      if (!isLocalClass && !isExtern) {
        const argCount = node.arguments?.length ?? 0;
        const prev = state.unknownCtorNeeded.get(name) ?? 0;
        state.unknownCtorNeeded.set(name, Math.max(prev, argCount));
      }
    }
  }

  // ── collectFunctionClassNames: pre-register .name values as string literals ──
  // Function declarations: function foo() {} → name = "foo"
  if (ts.isFunctionDeclaration(node) && node.name) {
    state.stringLiterals.add(node.name.text);
  }
  // Named function expressions: const x = function foo() {} → name = "foo"
  if (ts.isFunctionExpression(node) && node.name) {
    state.stringLiterals.add(node.name.text);
  }
  // Class declarations: class Foo {} → name = "Foo"
  if (ts.isClassDeclaration(node) && node.name) {
    state.stringLiterals.add(node.name.text);
  }
  // Named class expressions: const x = class Foo {} → name = "Foo"
  if (ts.isClassExpression(node) && node.name) {
    state.stringLiterals.add(node.name.text);
  }
  // Variable declarations with anonymous function/class initializers:
  // const foo = function() {} → name = "foo"
  // const Bar = class {} → name = "Bar"
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
    if (ts.isFunctionExpression(node.initializer) && !node.initializer.name) {
      state.stringLiterals.add(node.name.text);
    }
    if (ts.isArrowFunction(node.initializer)) {
      state.stringLiterals.add(node.name.text);
    }
    if (ts.isClassExpression(node.initializer) && !node.initializer.name) {
      state.stringLiterals.add(node.name.text);
    }
  }
  // Method declarations: { method() {} } → name = "method"
  if (ts.isMethodDeclaration(node) && node.name && ts.isIdentifier(node.name)) {
    state.stringLiterals.add(node.name.text);
  }
  // Getter/setter declarations
  if (ts.isGetAccessorDeclaration(node) && node.name && ts.isIdentifier(node.name)) {
    state.stringLiterals.add(`get ${node.name.text}`);
  }
  if (ts.isSetAccessorDeclaration(node) && node.name && ts.isIdentifier(node.name)) {
    state.stringLiterals.add(`set ${node.name.text}`);
  }

  // ── Recurse into children ──
  // Track computed property name depth for string literal collection
  if (ts.isComputedPropertyName(node)) {
    state.insideComputedPropertyName++;
    forEachChild(node, (child) => unifiedVisitNode(ctx, state, child));
    state.insideComputedPropertyName--;
    return; // already recursed
  }
  forEachChild(node, (child) => unifiedVisitNode(ctx, state, child));
}

/** Run all post-walk finalization (register imports based on collected state) */
export function finalizeUnifiedCollector(ctx: CodegenContext, state: UnifiedCollectorState): void {
  // ── collectConsoleImports finalize ──
  // In WASI mode, console.log/error use fd_write — skip JS host console imports
  if (!ctx.wasi) {
    const CONSOLE_METHODS = ["log", "warn", "error", "info", "debug"] as const;
    for (const method of CONSOLE_METHODS) {
      const needed = state.consoleNeededByMethod.get(method);
      if (!needed) continue;
      if (needed.has("number")) {
        const t = addFuncType(ctx, [{ kind: "f64" }], []);
        addImport(ctx, "env", `console_${method}_number`, { kind: "func", typeIdx: t });
      }
      if (needed.has("bool")) {
        const t = addFuncType(ctx, [{ kind: "i32" }], []);
        addImport(ctx, "env", `console_${method}_bool`, { kind: "func", typeIdx: t });
      }
      if (needed.has("string")) {
        const t = addFuncType(ctx, [{ kind: "externref" }], []);
        addImport(ctx, "env", `console_${method}_string`, { kind: "func", typeIdx: t });
      }
      if (needed.has("externref")) {
        const t = addFuncType(ctx, [{ kind: "externref" }], []);
        addImport(ctx, "env", `console_${method}_externref`, { kind: "func", typeIdx: t });
      }
    }
  }

  // ── collectPrimitiveMethodImports finalize ──
  // #1759: under WASI/standalone, template interpolation and String(number)
  // need a pure-Wasm default Number::toString helper. Do not emit the JS-host
  // env.number_toString import there; emit the native helper below instead.
  const needsNativeNumberToString = state.primitiveNeeded.has("number_toString") && (ctx.wasi || ctx.standalone);
  if (state.primitiveNeeded.has("number_toString") && !needsNativeNumberToString) {
    const t = addFuncType(ctx, [{ kind: "f64" }], [{ kind: "externref" }]);
    addImport(ctx, "env", "number_toString", { kind: "func", typeIdx: t });
  }
  // #1321: 2-arg `number_toString_radix(value, radix)` for `toString(radix)` calls.
  // Without this, the codegen validates the radix range but then calls 1-arg
  // `number_toString(value)`, silently producing decimal output for any radix.
  // #1335 Phase 1: standalone/WASI emits the safe-integer radix formatter in
  // pure Wasm instead of requesting the JS host import.
  const needsNativeNumberToStringRadix =
    state.primitiveNeeded.has("number_toString_radix") && (ctx.wasi || ctx.standalone);
  if (state.primitiveNeeded.has("number_toString_radix") && !needsNativeNumberToStringRadix) {
    const t = addFuncType(ctx, [{ kind: "f64" }, { kind: "f64" }], [{ kind: "externref" }]);
    addImport(ctx, "env", "number_toString_radix", { kind: "func", typeIdx: t });
  }
  // (#1644 Slice D) BigInt#toString — i64 receiver, optional i32 radix.
  if (state.primitiveNeeded.has("bigint_toString")) {
    const t = addFuncType(ctx, [{ kind: "i64" }], [{ kind: "externref" }]);
    addImport(ctx, "env", "bigint_toString", { kind: "func", typeIdx: t });
  }
  if (state.primitiveNeeded.has("bigint_toString_radix")) {
    const t = addFuncType(ctx, [{ kind: "i64" }, { kind: "i32" }], [{ kind: "externref" }]);
    addImport(ctx, "env", "bigint_toString_radix", { kind: "func", typeIdx: t });
  }
  // #1321 / #1335 Phase 2: in standalone / WASI mode there is no JS host to
  // satisfy the `number_toFixed` / `number_toPrecision` / `number_toExponential`
  // imports. Emit WasmGC-native implementations (registered under the same
  // funcMap names) instead. Emit order matters: number_toPrecision delegates to
  // the toFixed/toExponential helpers, so emitNativeNumberFormat emits those
  // first. The defined funcs participate in the late-import index-shift fixup
  // like emitNativeParseNumber's.
  if (ctx.wasi || ctx.standalone) {
    const fmtNative = new Set<string>();
    for (const n of [
      "number_toString",
      "number_toString_radix",
      "number_toFixed",
      "number_toExponential",
      "number_toPrecision",
    ]) {
      if (state.primitiveNeeded.has(n) && !ctx.funcMap.has(n)) fmtNative.add(n);
    }
    if (fmtNative.size > 0) {
      emitNativeNumberFormat(ctx, fmtNative);
    }
  } else {
    if (state.primitiveNeeded.has("number_toFixed")) {
      const t = addFuncType(ctx, [{ kind: "f64" }, { kind: "f64" }], [{ kind: "externref" }]);
      addImport(ctx, "env", "number_toFixed", { kind: "func", typeIdx: t });
    }
    if (state.primitiveNeeded.has("number_toPrecision")) {
      const t = addFuncType(ctx, [{ kind: "f64" }, { kind: "f64" }], [{ kind: "externref" }]);
      addImport(ctx, "env", "number_toPrecision", { kind: "func", typeIdx: t });
    }
    if (state.primitiveNeeded.has("number_toExponential")) {
      const t = addFuncType(ctx, [{ kind: "f64" }, { kind: "f64" }], [{ kind: "externref" }]);
      addImport(ctx, "env", "number_toExponential", { kind: "func", typeIdx: t });
    }
  }
  if (state.primitiveNeeded.has("string_compare") && !ctx.nativeStrings) {
    // In native strings mode, __str_compare Wasm helper handles this — no host import needed
    const t = addFuncType(ctx, [{ kind: "externref" }, { kind: "externref" }], [{ kind: "i32" }]);
    addImport(ctx, "env", "string_compare", { kind: "func", typeIdx: t });
  }

  // ── collectStringLiterals finalize ──
  // Register the empty string if any other strings are in the pool — it's used
  // implicitly by template expressions, default values, and many string operations (#668).
  // Don't add it unconditionally as that forces string_constants import on all modules.
  if (state.stringLiterals.size > 0) {
    state.stringLiterals.add("");
  }

  if (state.hasTypeofExprForStrings) {
    for (const s of ["number", "string", "boolean", "object", "undefined", "function", "symbol"]) {
      state.stringLiterals.add(s);
    }
  }
  if (state.hasTaggedTemplate) {
    getOrRegisterTemplateVecType(ctx);
  }
  if (state.stringLiterals.size > 0) {
    if (ctx.nativeStrings) {
      ensureNativeStringHelpers(ctx);
      for (const value of state.stringLiterals) {
        if (!ctx.stringGlobalMap.has(value)) {
          ctx.stringGlobalMap.set(value, -1);
        }
      }
    } else {
      addStringImports(ctx);
      for (const value of state.stringLiterals) {
        addStringConstantGlobal(ctx, value);
      }
    }
  }

  // ── collectStringMethodImports finalize ──
  {
    const NATIVE_STR_METHODS = new Set([
      "charAt",
      "charCodeAt",
      "substring",
      "slice",
      "at",
      "indexOf",
      "lastIndexOf",
      "includes",
      "startsWith",
      "endsWith",
      "trim",
      "trimStart",
      "trimEnd",
      "repeat",
      "padStart",
      "padEnd",
      "toLowerCase",
      "toUpperCase",
      "concat",
      "replace",
      "replaceAll",
      "split",
    ]);
    for (const method of state.stringMethodNeeded) {
      const nativeStringMethod = ctx.nativeStrings && NATIVE_STR_METHODS.has(method);
      if (nativeStringMethod) {
        ensureNativeStringHelpers(ctx);
      }
      // #682/#1474: standalone refuses RegExp-consuming string methods during
      // lowering, so do not pre-register JS-host string_* imports for them.
      if (ctx.standalone && (method === "match" || method === "matchAll" || method === "search")) {
        continue;
      }
      if (ctx.standalone && state.stringRegexpMethodNeeded.has(method)) {
        continue;
      }
      if (nativeStringMethod && !state.stringRegexpMethodNeeded.has(method)) continue;
      const sig = STRING_METHODS[method]!;
      const params: ValType[] = [{ kind: "externref" }, ...sig.params];
      const t = addFuncType(ctx, params, [sig.result]);
      addImport(ctx, "env", `string_${method}`, { kind: "func", typeIdx: t });
    }
    if ((state.stringMethodNeeded.has("split") || state.stringMethodNeeded.has("match")) && !ctx.nativeStrings) {
      if (!ctx.funcMap.has("__extern_get")) {
        const getType = addFuncType(ctx, [{ kind: "externref" }, { kind: "externref" }], [{ kind: "externref" }]);
        addImport(ctx, "env", "__extern_get", { kind: "func", typeIdx: getType });
      }
      if (!ctx.funcMap.has("__extern_length")) {
        const lenType = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "f64" }]);
        addImport(ctx, "env", "__extern_length", { kind: "func", typeIdx: lenType });
      }
    }
  }

  // ── collectMathImports finalize ──
  for (const method of state.mathNeeded) {
    if (method === "random") {
      // #1322: in WASI/standalone mode, emit a Wasm `Math_random` that calls
      // WASI `random_get(ptr, 8)` for entropy. The `random_get` import was
      // already registered EARLY by registerWasiImports (before any defined
      // functions) so adding it here doesn't shift indices of helpers like
      // `__str_copy_tree`.
      if (ctx.wasi) {
        ctx.pendingMathMethods.add(method);
      } else {
        const typeIdx = addFuncType(ctx, [], [{ kind: "f64" }]);
        addImport(ctx, "env", `Math_${method}`, { kind: "func", typeIdx });
      }
    } else {
      ctx.pendingMathMethods.add(method);
    }
  }
  // ToUint32: defer emission until after all imports are registered (#1094).
  // Registering as a defined function here would leave a stale funcMap index
  // since subsequent imports added via addImport (e.g. __register_prototype)
  // do not shift defined-function indices. emitToUint32Helper() runs later.
  if (state.mathNeedsToUint32) {
    ctx.needsToUint32 = true;
  }

  // ── collectParseImports finalize ──
  // #1663 — standalone / WASI targets have no JS runtime to satisfy the
  // env.parseInt / env.parseFloat imports, so emit WasmGC-native scanners
  // instead (registered under the same funcMap names; call sites unchanged).
  // The functions are emitted as DEFINED funcs here; the batched late-import
  // shift (`fixupModuleFuncIndices`, walked on every later `addImport`) keeps
  // their funcMap indices and internal `call __str_flatten` refs correct as
  // the remaining finalize blocks register more imports (#1666).
  {
    const parseNative = new Set<string>();
    for (const name of state.parseNeeded) {
      if (ctx.funcMap.has(name)) continue; // already registered (e.g. lib.d.ts) (#1109)
      if (ctx.wasi || ctx.standalone) {
        parseNative.add(name);
        continue;
      }
      if (name === "parseInt") {
        const typeIdx = addFuncType(ctx, [{ kind: "externref" }, { kind: "f64" }], [{ kind: "f64" }]);
        addImport(ctx, "env", name, { kind: "func", typeIdx });
      } else {
        const typeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "f64" }]);
        addImport(ctx, "env", name, { kind: "func", typeIdx });
      }
    }
    if (parseNative.size > 0) {
      emitNativeParseNumber(ctx, parseNative);
    }
  }

  // ── collectDateParseHostImports finalize (#2678) ──
  // HOST mode: register `__date_parse_host(externref) -> f64` up-front so the
  // call sites (Date.parse / new Date(<string>)) get a stable funcidx without a
  // mid-body late-import shift (#2043). Standalone/WASI never reach here (the
  // scan only sets the flag for host mode); they keep the native `__date_parse`.
  if (state.dateParseHostNeeded && !ctx.standalone && !ctx.wasi && !ctx.funcMap.has("__date_parse_host")) {
    const typeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "f64" }]);
    addImport(ctx, "env", "__date_parse_host", { kind: "func", typeIdx });
  }

  // ── collectURIImports finalize ──
  // #2500 — the four URI globals are JS-host `env.*` imports in host mode. Under
  // `--target wasi`/`--target standalone` there is no host, so the call site
  // previously fell through to a `ref.test`/`ref.cast` of the argument and
  // returned `null`. Emit the pure-Wasm `__uri_encode` / `__uri_decode` helpers
  // instead (registered as DEFINED funcs; the batched late-import shift keeps
  // their funcMap index + sibling-call targets correct as later imports
  // register). The four NAMES remain mapped to the host import in host mode; in
  // standalone mode the call site (calls.ts) routes each name through the native
  // helper with its per-function preserved/reserved mask.
  {
    let needsNativeEncode = false;
    let needsNativeDecode = false;
    for (const name of state.uriNeeded) {
      if (ctx.funcMap.has(name)) continue;
      if (ctx.wasi || ctx.standalone) {
        if (name === "encodeURI" || name === "encodeURIComponent") {
          needsNativeEncode = true;
          continue;
        }
        if (name === "decodeURI" || name === "decodeURIComponent") {
          needsNativeDecode = true;
          continue;
        }
      }
      const typeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "externref" }]);
      addImport(ctx, "env", name, { kind: "func", typeIdx });
    }
    if (needsNativeEncode) {
      emitNativeUriEncode(ctx);
    }
    if (needsNativeDecode) {
      emitNativeUriDecode(ctx);
    }
  }

  // (#3063 / #3064) Legacy `escape` / `unescape` (§B.2.1.1 / §B.2.1.2).
  //   • JS-host mode: register an `(externref) -> externref` env host import
  //     delegating to the native JS `escape` / `unescape` (runtime.ts). The
  //     generic call-site routing (calls.ts `funcMap.get(name)`) dispatches it
  //     and ToString-coerces the argument, exactly like the URI globals above.
  //   • Standalone / WASI (#3064): there is no host, so emit the pure-Wasm
  //     `__escape` / `__unescape` helpers (registered as DEFINED funcs; the
  //     batched late-import shift keeps their funcMap index correct as later
  //     imports register). The call site (calls.ts) routes each name through
  //     its native helper.
  // A user-declared `escape` / `unescape` already sits in funcMap → the `has`
  // guard skips it in both lanes.
  for (const name of state.escapeNeeded) {
    if (ctx.funcMap.has(name)) continue;
    if (ctx.standalone || ctx.wasi) {
      if (name === "escape") emitNativeEscape(ctx);
      else emitNativeUnescape(ctx);
      continue;
    }
    const typeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "externref" }]);
    addImport(ctx, "env", name, { kind: "func", typeIdx });
  }

  // ── collectStringStaticImports finalize ──
  if (state.needsFromCharCode) {
    if (ctx.nativeStrings) {
      // #1598: pure-Wasm path — emit __str_fromCharCode helper, no host import.
      // nativeStrings is forced on for --target wasi / standalone, so this also
      // covers the no-JS-host case. The call site (calls.ts) routes to the
      // helper and never registers env.String_fromCharCode in this mode.
      ensureNativeStringHelpers(ctx);
    } else {
      const typeIdx = addFuncType(ctx, [{ kind: "f64" }], [{ kind: "externref" }]);
      addImport(ctx, "env", "String_fromCharCode", { kind: "func", typeIdx });
    }
  }
  if (state.needsFromCodePoint) {
    if (ctx.nativeStrings) {
      // Native strings mode: use pure-Wasm helper, no host import needed
      ensureNativeStringHelpers(ctx);
    } else {
      const typeIdx = addFuncType(ctx, [{ kind: "f64" }], [{ kind: "externref" }]);
      addImport(ctx, "env", "String_fromCodePoint", { kind: "func", typeIdx });
    }
  }

  // ── collectPromiseImports finalize ──
  // Only register STATIC Promise methods (e.g., Promise.resolve, Promise.all).
  // Instance methods (.then/.catch/.finally) are NOT pre-registered because
  // adding their func types here shifts struct type indices, breaking
  // non-Promise code in the same module (#855 regression fix).
  //
  // (#1326 Phase 1B) In standalone (WASI) mode, skip pre-registration of
  // `Promise_resolve` / `Promise_reject` — these are unsatisfiable host
  // imports there; the codegen call site emits Wasm-native `struct.new
  // $Promise` instead. Other Promise methods (all/race/allSettled/any)
  // are still host-routed in 1B; Phase 3 will add native combinators.
  //
  // (#1368) Aggregators (all/race/allSettled/any) take (thisArg, iterable) so
  // the codegen can pass through `Promise.all.call(C, …)` thisArg semantics
  // and the runtime can default to globalThis.Promise when wasm passes null.
  // Resolve/reject keep their original 1-arg signature.
  for (const method of state.promiseNeeded) {
    if (method === "then" || method === "catch" || method === "finally") continue;
    if (ctx.wasi && (method === "resolve" || method === "reject")) continue;
    // (#2867 Gap 4) Under the native-`$Promise` carrier, `Promise.all`/`Promise.race`
    // over an array literal lower to the host-free native combinator (no host
    // import). Skip the unsatisfiable `Promise_all`/`Promise_race` pre-registration
    // here; the host path (generic iterables / subclass receivers) still
    // lazily `ensureLateImport`s it at the call site when actually needed.
    if (isStandalonePromiseActive(ctx) && (method === "all" || method === "race")) continue;
    const importName = `Promise_${method}`;
    if (!ctx.funcMap.has(importName)) {
      const isAggregator = method === "all" || method === "race" || method === "allSettled" || method === "any";
      // (#1116) Aggregators take (thisArg, iterable, directCall) so the runtime
      // can distinguish a codegen-default thisArg from an explicit user-provided
      // one (which may need to throw TypeError per spec).
      const params: ValType[] = isAggregator
        ? [{ kind: "externref" }, { kind: "externref" }, { kind: "i32" }]
        : [{ kind: "externref" }];
      const typeIdx = addFuncType(ctx, params, [{ kind: "externref" }]);
      addImport(ctx, "env", importName, { kind: "func", typeIdx });
    }
  }
  if (state.promiseNeedConstructor && !ctx.funcMap.has("Promise_new")) {
    const typeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "externref" }]);
    addImport(ctx, "env", "Promise_new", { kind: "func", typeIdx });
  }

  // ── collectJsonImports finalize ──
  // (#1599 Phase 1) In standalone (no-JS-host) / WASI mode there is no JS
  // host to provide `env::JSON_stringify` / `env::JSON_parse`. Registering
  // them would produce a module that fails at instantiation with
  // `unknown import env::JSON_*`. Skip the import registration here; the
  // call site in expressions/calls.ts emits a clear compile error for the
  // unsupported (non-primitive) shapes. The primitive `JSON.stringify`
  // slice (#1324) is still lowered to pure Wasm and needs no host import.
  const jsonHostUnavailable = ctx.wasi || ctx.standalone;
  if (!jsonHostUnavailable && (state.jsonNeedStringify || state.jsonNeedParse)) {
    addUnionImports(ctx);
  }
  if (!jsonHostUnavailable && state.jsonNeedStringify) {
    // (value: externref, replacer: externref, space: externref) -> externref
    const typeIdx = addFuncType(
      ctx,
      [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
      [{ kind: "externref" }],
    );
    addImport(ctx, "env", "JSON_stringify", { kind: "func", typeIdx });
  }
  if (!jsonHostUnavailable && state.jsonNeedParse) {
    // #2013 — (text, reviver) so JSON.parse can apply §25.5.1
    // InternalizeJSONProperty. The reviver is `ref.null.extern` when absent.
    const typeIdx = addFuncType(ctx, [{ kind: "externref" }, { kind: "externref" }], [{ kind: "externref" }]);
    addImport(ctx, "env", "JSON_parse", { kind: "func", typeIdx });
  }

  // ── collectCallbackImports finalize ──
  if (state.callbackFound || state.getterCallbackFound || state.asyncCpsFound) {
    const typeIdx = addFuncType(ctx, [{ kind: "i32" }, { kind: "externref" }], [{ kind: "externref" }]);
    if ((state.callbackFound || state.asyncCpsFound) && !ctx.funcMap.has("__make_callback")) {
      addImport(ctx, "env", "__make_callback", { kind: "func", typeIdx });
    }
    if (state.getterCallbackFound) {
      // __make_getter_callback: same signature — wraps a function so 'this' is bound (#929)
      // Used for Object.defineProperty accessor descriptors (getter/setter callbacks).
      addImport(ctx, "env", "__make_getter_callback", { kind: "func", typeIdx });
    }
  }

  // ── collectAsyncCpsImports finalize (#1042) ──
  // The CPS driver (emitAsyncStateMachine) emits `Promise_resolve` (wrap the
  // awaited value) and `Promise_then2` (chain the continuation) by stable
  // funcMap index. Register both upfront so the outer async body never takes
  // the late-import path (its `call` opcodes would not be shifted — #1384).
  // `__make_callback` is registered above. Idempotent via funcMap guard so a
  // module that also uses `.then(cb1,cb2)` / `Promise.resolve` is unaffected.
  if (state.asyncCpsFound || state.asyncHostDriveFound) {
    if (!ctx.funcMap.has("Promise_resolve")) {
      const typeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "externref" }]);
      addImport(ctx, "env", "Promise_resolve", { kind: "func", typeIdx });
    }
    if (!ctx.funcMap.has("Promise_then2")) {
      const typeIdx = addFuncType(
        ctx,
        [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
        [{ kind: "externref" }],
      );
      addImport(ctx, "env", "Promise_then2", { kind: "func", typeIdx });
    }
  }

  // ── collectAsyncHostDriveImports finalize (#1042 host drive) ──
  // The host settle backend of the #2906 resume machine additionally needs
  // `__make_callback` (its step adapters are `__cb_<id>` reactions) and the
  // deferred-promise trio: `Promise_new_pending` allocates the result promise
  // the async fn returns; the resume machine settles it later from a microtask
  // via `Promise_settle_resolve`/`Promise_settle_reject` (runtime.ts stashes
  // the resolve/reject capabilities on the promise as `__r`/`__j`). The settle
  // imports declare an externref result (the JS fns return undefined) so the
  // shared `call <fulfill>; drop` settle shape stays uniform across backends.
  if (state.asyncHostDriveFound) {
    if (!ctx.funcMap.has("__make_callback")) {
      const typeIdx = addFuncType(ctx, [{ kind: "i32" }, { kind: "externref" }], [{ kind: "externref" }]);
      addImport(ctx, "env", "__make_callback", { kind: "func", typeIdx });
    }
    if (!ctx.funcMap.has("Promise_new_pending")) {
      const typeIdx = addFuncType(ctx, [], [{ kind: "externref" }]);
      addImport(ctx, "env", "Promise_new_pending", { kind: "func", typeIdx });
    }
    const settleTypeIdx = addFuncType(ctx, [{ kind: "externref" }, { kind: "externref" }], [{ kind: "externref" }]);
    if (!ctx.funcMap.has("Promise_settle_resolve")) {
      addImport(ctx, "env", "Promise_settle_resolve", { kind: "func", typeIdx: settleTypeIdx });
    }
    if (!ctx.funcMap.has("Promise_settle_reject")) {
      addImport(ctx, "env", "Promise_settle_reject", { kind: "func", typeIdx: settleTypeIdx });
    }
  }

  // ── collectFunctionalArrayImports finalize ──
  if (state.funcArrayNeed1) {
    if (ctx.fast) {
      const typeIdx = addFuncType(ctx, [{ kind: "externref" }, { kind: "i32" }], [{ kind: "i32" }]);
      addImport(ctx, "env", "__call_1_i32", { kind: "func", typeIdx });
    } else {
      const typeIdx = addFuncType(ctx, [{ kind: "externref" }, { kind: "f64" }], [{ kind: "f64" }]);
      addImport(ctx, "env", "__call_1_f64", { kind: "func", typeIdx });
    }
  }
  if (state.funcArrayNeed2) {
    if (ctx.fast) {
      const typeIdx = addFuncType(ctx, [{ kind: "externref" }, { kind: "i32" }, { kind: "i32" }], [{ kind: "i32" }]);
      addImport(ctx, "env", "__call_2_i32", { kind: "func", typeIdx });
    } else {
      const typeIdx = addFuncType(ctx, [{ kind: "externref" }, { kind: "f64" }, { kind: "f64" }], [{ kind: "f64" }]);
      addImport(ctx, "env", "__call_2_f64", { kind: "func", typeIdx });
    }
  }

  // ── collectUnionImports finalize ──
  if (state.unionFound) {
    addUnionImports(ctx);
  }

  // ── collectGeneratorImports finalize ──
  // The full set of generator host imports lives in `addGeneratorImports`
  // (in `./index.ts`) so the IR path can call the same helper when it
  // claims a generator function (#1169f). The helper is idempotent —
  // guards on `ctx.funcMap.has("__gen_create_buffer")` internally.
  if (state.generatorFound) {
    const needsNoJsHostFallback =
      (ctx.standalone || ctx.wasi) && sourceNeedsGeneratorHostImports(ctx, state.sourceFile);
    if (!(ctx.standalone || ctx.wasi) || needsNoJsHostFallback) {
      addGeneratorImports(ctx, { allowNoJsHost: needsNoJsHostFallback });
    }
  }

  // ── collectIteratorImports finalize ──
  if (state.iteratorFound && !ctx.standalone && !ctx.wasi) {
    addIteratorImports(ctx);
  }

  // ── collectArrayIteratorImports finalize ──
  if (state.arrayIteratorFound && !ctx.standalone && !ctx.wasi) {
    addArrayIteratorImports(ctx);
    // Array iterator results are externref iterators consumed via for-of generic path
    if (!state.iteratorFound) {
      addIteratorImports(ctx);
    }
  }

  // ── collectForInStringLiterals finalize ──
  // (#2572) Only register the `__for_in_*` host imports in JS-host mode. A
  // no-JS-host target (standalone / WASI) has no host to satisfy them — and they
  // would otherwise leak into the module (validates, can't instantiate). In that
  // mode `compileForInStatement` routes through the native object runtime
  // (`__object_keys` + `__extern_length/_get_idx/_has`) instead, so leaving the
  // host imports unregistered is exactly what selects the native path there.
  if (state.forInFound && !ctx.standalone && !ctx.wasi) {
    addForInImports(ctx);
  }
  if (state.forInLiterals.size > 0) {
    if (ctx.nativeStrings) {
      ensureNativeStringHelpers(ctx);
      for (const value of state.forInLiterals) {
        if (!ctx.stringGlobalMap.has(value)) ctx.stringGlobalMap.set(value, -1);
      }
    } else {
      addStringImports(ctx);
      for (const value of state.forInLiterals) {
        addStringConstantGlobal(ctx, value);
      }
    }
  }

  // ── collectInExprStringLiterals finalize ──
  if (state.inExprLiterals.size > 0) {
    if (ctx.nativeStrings) {
      ensureNativeStringHelpers(ctx);
      for (const value of state.inExprLiterals) {
        if (!ctx.stringGlobalMap.has(value)) ctx.stringGlobalMap.set(value, -1);
      }
    } else {
      addStringImports(ctx);
      for (const value of state.inExprLiterals) {
        addStringConstantGlobal(ctx, value);
      }
    }
  }

  // ── collectObjectMethodStringLiterals finalize ──
  if (state.objectMethodHasValues) {
    addUnionImports(ctx);
  }
  if (state.objectMethodLiterals.size > 0) {
    if (ctx.nativeStrings) {
      ensureNativeStringHelpers(ctx);
      for (const value of state.objectMethodLiterals) {
        if (!ctx.stringGlobalMap.has(value)) ctx.stringGlobalMap.set(value, -1);
      }
    } else {
      addStringImports(ctx);
      for (const value of state.objectMethodLiterals) {
        addStringConstantGlobal(ctx, value);
      }
    }
  }

  // ── collectWrapperConstructors finalize ──
  if (state.wrapperFound) {
    ensureWrapperTypes(ctx);
  }

  // ── collectUnknownConstructorImports finalize ──
  for (const [name, argCount] of state.unknownCtorNeeded) {
    const importName = `__new_${name}`;
    if (ctx.funcMap.has(importName)) continue;
    // (#1104 Phase 1) In WASI/standalone mode, the JS host is unavailable —
    // emit Wasm-native `__new_<ErrorName>` functions that build a
    // `$Error_struct` for the 8 built-in Error constructors instead of
    // unsatisfiable `env.__new_<ErrorName>` host imports. JS-host mode is
    // unchanged.
    // #1473 — standalone mode has no JS host either, so it needs the same
    // in-module Error constructors as WASI mode.
    if ((ctx.wasi || ctx.standalone) && isWasiErrorName(name)) {
      emitWasiErrorConstructor(ctx, name, argCount);
      continue;
    }
    // (#2026 PR-1b) In no-JS-host mode (WASI / standalone) an `env.__new_<name>`
    // import is *never* satisfiable — there is no host to provide it — and the
    // strict-import allowlist gate (#1524/#2094) rejects it at registration
    // time, so a single `new K()` on a value-bound class identifier fails the
    // whole standalone compile (the original "Host import env.__new_K …" error).
    // Skip the host import entirely here: the dynamic-new fallback in
    // `compileNewExpression` (`emitDynamicNewFallback`) is the resolution path
    // in standalone — it reads the class-object descriptor's `__tag` and
    // dispatches to the matching `<Class>_new` with pure Wasm (no host import),
    // and on a no-match descriptor it yields a null externref (the same result
    // the absent-import `else` branch produced before). Genuine JS-host
    // builtins cannot exist in standalone anyway, so there is nothing to lose.
    // Host (JS) mode still registers the import for those builtins.
    if (ctx.wasi || ctx.standalone) {
      continue;
    }
    const params: ValType[] = Array.from({ length: argCount }, () => ({ kind: "externref" }) as ValType);
    const typeIdx = addFuncType(ctx, params, [{ kind: "externref" }]);
    addImport(ctx, "env", importName, { kind: "func", typeIdx });
  }
}

/**
 * Perform a single AST walk that collects all import-phase information.
 * Replaces 19 separate collect* passes with one O(n) traversal.
 * (#592)
 */

export function resolveGenericCallSiteTypes(
  ctx: CodegenContext,
  funcName: string,
  sourceFile: ts.SourceFile,
): { params: ValType[]; results: ValType[] } | null {
  let found: { params: ValType[]; results: ValType[] } | null = null;

  function visit(node: ts.Node) {
    if (found) return;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === funcName) {
      const sig = ctx.checker.getResolvedSignature(node);
      if (sig) {
        const params: ValType[] = [];
        const sigParams = sig.getParameters();
        for (let i = 0; i < sigParams.length; i++) {
          const paramType = ctx.checker.getTypeOfSymbol(sigParams[i]!);
          params.push(resolveWasmType(ctx, paramType));
        }
        const retType = ctx.checker.getReturnTypeOfSignature(sig);
        // (#2905) Carrier own-return guard. resolveWasmType(Promise<T>) lowers to
        // externref under the native $Promise carrier (index.ts), but an async
        // callee's OWN wasm result is the unwrapped T — its body returns raw T;
        // wrapAsyncReturn boxes to $Promise only at the *call* site. So for an
        // async callee under the carrier, pre-unwrap to keep this inferred
        // signature matching the actually-compiled fn (else externref-result vs
        // f64-body = invalid Wasm). Gated on the carrier so off-carrier bytes are
        // identical (effRet === retType). Non-async fns returning Promise<T> keep
        // retType → resolveWasmType → externref, which is correct (body returns a
        // real promise). Mirrors the main async-return sites (e.g. :2930).
        const callDecl = sig.getDeclaration();
        const calleeIsAsync = callDecl ? hasAsyncModifier(callDecl) : false;
        const effRetType =
          isStandalonePromiseActive(ctx) && calleeIsAsync ? unwrapPromiseType(retType, ctx.checker) : retType;
        const results: ValType[] = isVoidType(effRetType) ? [] : [resolveWasmType(ctx, effRetType)];
        found = { params, results };
      }
    }
    forEachChild(node, visit);
  }

  forEachChild(sourceFile, visit);
  return found;
}

/**
 * Infer a concrete type for an untyped function parameter by scanning call sites.
 * When a parameter has no type annotation (TS gives it `any`), we look at every
 * call to that function and collect the argument types at the given index.
 * If all call sites agree on a single concrete wasm type, we return it.
 * Returns null if no call site found or types disagree.
 */
export function inferParamTypeFromCallSites(
  ctx: CodegenContext,
  funcName: string,
  paramIndex: number,
  sourceFile: ts.SourceFile,
): ValType | null {
  let agreed: ValType | null = null;
  let conflict = false;

  function visit(node: ts.Node) {
    if (conflict) return;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === funcName) {
      const arg = node.arguments[paramIndex];
      if (arg) {
        const argType = ctx.checker.getTypeAtLocation(arg);
        // Skip if the argument itself is also `any` — no useful info
        if (argType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) {
          // Don't count this call site — it doesn't help
        } else {
          const wasmType = resolveWasmType(ctx, argType);
          if (agreed === null) {
            agreed = wasmType;
          } else if (agreed.kind !== wasmType.kind) {
            conflict = true;
          } else if (
            (agreed.kind === "ref" || agreed.kind === "ref_null") &&
            (wasmType.kind === "ref" || wasmType.kind === "ref_null") &&
            (agreed as { typeIdx: number }).typeIdx !== (wasmType as { typeIdx: number }).typeIdx
          ) {
            conflict = true;
          }
        }
      }
    }
    forEachChild(node, visit);
  }

  forEachChild(sourceFile, visit);
  return conflict ? null : agreed;
}

/**
 * #1121: Fallback param-type inference from body usage. Used when
 * `inferParamTypeFromCallSites` finds no call sites (e.g. an exported
 * entrypoint that is only called from JS host) but the function body
 * itself reveals how the parameter is used.
 *
 * Recognises three numeric-flow patterns:
 *  1. `param` passed as an argument to a function whose return is in
 *     `ctx.numericReturnTypes` (the recursive numeric kernels detected
 *     by inferNumericReturnTypes).
 *  2. `param` used as an operand of a numeric binary operator
 *     (+, -, *, /, %, **, |, &, ^, <<, >>, >>>, ToInt32 coercion).
 *  3. `param` used as a numeric loop bound / comparison operand
 *     (<, <=, >, >=).
 *
 * Returns null if none of those patterns are found, leaving the param
 * unchanged. This is intentionally conservative — the call-site path
 * is still preferred when it has information.
 */
export function inferParamTypeFromBody(
  ctx: CodegenContext,
  decl: ts.FunctionLikeDeclaration,
  paramIndex: number,
): ValType | null {
  if (!decl.body) return null;
  const param = decl.parameters[paramIndex];
  if (!param || !ts.isIdentifier(param.name)) return null;
  const paramName = param.name.text;

  let foundNumericUse = false;
  function visit(node: ts.Node) {
    if (foundNumericUse) return;
    // Don't descend into nested functions — the param doesn't propagate there
    // unless captured, and we don't track capture flow here.
    if (
      node !== decl &&
      (ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isAccessor(node) ||
        ts.isConstructorDeclaration(node))
    ) {
      return;
    }

    // (1) param passed to a known numeric function
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const calleeName = node.expression.text;
      if (ctx.numericReturnTypes?.has(calleeName)) {
        for (const arg of node.arguments) {
          if (ts.isIdentifier(arg) && arg.text === paramName) {
            foundNumericUse = true;
            return;
          }
        }
      }
    }

    // (2) param used in a numeric binary expression
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      const numericOps = new Set<ts.SyntaxKind>([
        ts.SyntaxKind.PlusToken,
        ts.SyntaxKind.MinusToken,
        ts.SyntaxKind.AsteriskToken,
        ts.SyntaxKind.AsteriskAsteriskToken,
        ts.SyntaxKind.SlashToken,
        ts.SyntaxKind.PercentToken,
        ts.SyntaxKind.AmpersandToken,
        ts.SyntaxKind.BarToken,
        ts.SyntaxKind.CaretToken,
        ts.SyntaxKind.LessThanLessThanToken,
        ts.SyntaxKind.GreaterThanGreaterThanToken,
        ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
        ts.SyntaxKind.LessThanToken,
        ts.SyntaxKind.LessThanEqualsToken,
        ts.SyntaxKind.GreaterThanToken,
        ts.SyntaxKind.GreaterThanEqualsToken,
      ]);
      if (numericOps.has(op)) {
        const isParamId = (e: ts.Expression): boolean => ts.isIdentifier(e) && e.text === paramName;
        // Skip when the OTHER operand is a string literal — `+` could mean
        // string concatenation. The TS checker will already have given us
        // a string-typed param in that case, so this guard is defensive.
        if (op === ts.SyntaxKind.PlusToken) {
          if (
            (isParamId(node.left) && !ts.isStringLiteral(node.right)) ||
            (isParamId(node.right) && !ts.isStringLiteral(node.left))
          ) {
            foundNumericUse = true;
            return;
          }
        } else {
          if (isParamId(node.left) || isParamId(node.right)) {
            foundNumericUse = true;
            return;
          }
        }
      }
    }

    forEachChild(node, visit);
  }
  forEachChild(decl.body, visit);
  return foundNumericUse ? { kind: "f64" } : null;
}

/**
 * #1121: Infer numeric (f64) return types for functions whose body is a
 * purely-numeric kernel even when TypeScript reports the return as
 * `any`/`unknown` (e.g. unannotated recursive helpers like
 * `function fib(n) { ... }`).
 *
 * We do a fixpoint over the entire source file:
 *  1. Seed: every function declaration whose TS return type is implicit
 *     any/unknown becomes a candidate for f64 promotion (assuming numeric).
 *  2. Iterate: a candidate stays in the set only while every `return X`
 *     in its body produces a value whose type is structurally numeric
 *     under the assumption that all other candidates also return f64.
 *  3. The fixpoint converges in O(N * passes) where passes is bounded by
 *     the number of candidates.
 *
 * This intentionally does NOT consider parameter types — by the time we
 * are called, the param-inference pass has already retyped each
 * implicit-any parameter via `inferParamTypeFromCallSites`. We only need
 * to fix the return-type side, which is what TS gives up on for
 * recursive numeric kernels.
 */
export function inferNumericReturnTypes(ctx: CodegenContext, sourceFile: ts.SourceFile): Map<string, ValType> {
  // Collect all function declarations whose return type TS reports as any/unknown.
  // These are the only functions we may promote.
  const candidates = new Map<string, ts.FunctionDeclaration>();
  function collectFns(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      // Skip if explicit return type annotation is present
      if (node.type) {
        return; // explicit annotation — TS already told us the answer
      }
      // Skip generator/async functions — return type semantics differ
      if (node.asteriskToken || node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) {
        return;
      }
      const sig = ctx.checker.getSignatureFromDeclaration(node);
      if (!sig) return;
      const retType = ctx.checker.getReturnTypeOfSignature(sig);
      const isImplicitAny = (retType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
      if (isImplicitAny) {
        candidates.set(node.name.text, node);
      }
    }
    forEachChild(node, collectFns);
  }
  forEachChild(sourceFile, collectFns);
  if (candidates.size === 0) return new Map();

  // Inference set: starts with all candidates, and shrinks as we eliminate
  // any whose body cannot uniformly return numeric.
  const numeric = new Set<string>(candidates.keys());

  /**
   * Returns true if `expr` produces a value that is structurally numeric
   * under the optimistic assumption that every name in `numeric` returns
   * f64.
   *
   * Conservative: any unrecognised construct returns false. A depth
   * guard (MAX_DEPTH = 64) bails out for pathological deeply-nested
   * source — the answer for those is conservatively `false`, leaving the
   * function on its TS-derived return type. This keeps the inference
   * runtime worst-case O(body_size) per call instead of growing with
   * unbounded source-AST depth.
   */
  const MAX_NUMERIC_DEPTH = 64;
  function isNumericExpr(expr: ts.Expression, paramNames: Set<string>, depth = 0): boolean {
    if (depth > MAX_NUMERIC_DEPTH) return false;
    if (ts.isParenthesizedExpression(expr)) {
      return isNumericExpr(expr.expression, paramNames, depth + 1);
    }
    if (ts.isAsExpression(expr) || ts.isTypeAssertionExpression(expr) || ts.isNonNullExpression(expr)) {
      return isNumericExpr(expr.expression, paramNames, depth + 1);
    }
    if (ts.isNumericLiteral(expr)) return true;
    if (expr.kind === ts.SyntaxKind.TrueKeyword || expr.kind === ts.SyntaxKind.FalseKeyword) return true;
    if (ts.isPrefixUnaryExpression(expr)) {
      const o = expr.operator;
      if (o === ts.SyntaxKind.PlusToken || o === ts.SyntaxKind.MinusToken || o === ts.SyntaxKind.TildeToken) {
        return isNumericExpr(expr.operand, paramNames, depth + 1);
      }
      if (o === ts.SyntaxKind.ExclamationToken) {
        return true; // !X is boolean → i32, treat as numeric
      }
      return false;
    }
    if (ts.isPostfixUnaryExpression(expr)) {
      // ++ / -- on a numeric local
      return isNumericExpr(expr.operand, paramNames, depth + 1);
    }
    if (ts.isBinaryExpression(expr)) {
      const op = expr.operatorToken.kind;
      const numericOps = new Set<ts.SyntaxKind>([
        ts.SyntaxKind.PlusToken,
        ts.SyntaxKind.MinusToken,
        ts.SyntaxKind.AsteriskToken,
        ts.SyntaxKind.AsteriskAsteriskToken,
        ts.SyntaxKind.SlashToken,
        ts.SyntaxKind.PercentToken,
        ts.SyntaxKind.AmpersandToken,
        ts.SyntaxKind.BarToken,
        ts.SyntaxKind.CaretToken,
        ts.SyntaxKind.LessThanLessThanToken,
        ts.SyntaxKind.GreaterThanGreaterThanToken,
        ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
      ]);
      const cmpOps = new Set<ts.SyntaxKind>([
        ts.SyntaxKind.LessThanToken,
        ts.SyntaxKind.LessThanEqualsToken,
        ts.SyntaxKind.GreaterThanToken,
        ts.SyntaxKind.GreaterThanEqualsToken,
        ts.SyntaxKind.EqualsEqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsEqualsToken,
        ts.SyntaxKind.EqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsToken,
      ]);
      if (numericOps.has(op)) {
        return isNumericExpr(expr.left, paramNames, depth + 1) && isNumericExpr(expr.right, paramNames, depth + 1);
      }
      if (cmpOps.has(op)) {
        // Comparisons return boolean (i32), counted as numeric for our purposes.
        return isNumericExpr(expr.left, paramNames, depth + 1) && isNumericExpr(expr.right, paramNames, depth + 1);
      }
      // && / || / ?? return one of the operand types — accept only when both are numeric
      if (
        op === ts.SyntaxKind.AmpersandAmpersandToken ||
        op === ts.SyntaxKind.BarBarToken ||
        op === ts.SyntaxKind.QuestionQuestionToken
      ) {
        return isNumericExpr(expr.left, paramNames, depth + 1) && isNumericExpr(expr.right, paramNames, depth + 1);
      }
      return false;
    }
    if (ts.isConditionalExpression(expr)) {
      return (
        isNumericExpr(expr.whenTrue, paramNames, depth + 1) && isNumericExpr(expr.whenFalse, paramNames, depth + 1)
      );
    }
    if (ts.isIdentifier(expr)) {
      // Param of the function being checked → assumed numeric (we only run
      // this analysis when all params are already numeric).
      if (paramNames.has(expr.text)) return true;
      // Other identifiers: rely on the TS checker. This catches
      // numeric local variables, numeric module globals, etc. Implicit-any
      // identifiers fail this test (return false) — that is the safe answer.
      const t = ctx.checker.getTypeAtLocation(expr);
      if (
        (t.flags &
          (ts.TypeFlags.Number | ts.TypeFlags.NumberLiteral | ts.TypeFlags.Boolean | ts.TypeFlags.BooleanLiteral)) !==
        0
      ) {
        return true;
      }
      return false;
    }
    if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression)) {
      const calleeName = expr.expression.text;
      // Self-recursion / mutual recursion within our candidate set → assumed numeric
      if (numeric.has(calleeName)) {
        // Also require all arguments to be numeric (body still needs to
        // produce numeric values for the call to be a numeric kernel call)
        return expr.arguments.every((a) => isNumericExpr(a as ts.Expression, paramNames, depth + 1));
      }
      // Any other call: trust TS's reported return type
      const t = ctx.checker.getTypeAtLocation(expr);
      if (
        (t.flags &
          (ts.TypeFlags.Number | ts.TypeFlags.NumberLiteral | ts.TypeFlags.Boolean | ts.TypeFlags.BooleanLiteral)) !==
        0
      ) {
        return true;
      }
      return false;
    }
    return false;
  }

  // One-time scan: collect all return expressions inside each candidate's
  // body, plus the param-name set and a precomputed param-numericness
  // check. Caching these means the fixpoint loop below does NOT re-walk
  // the AST on each iteration — it only re-runs `isNumericExpr` against
  // the cached return expressions. This bounds total work to O(candidates
  // × cached returns × MAX_NUMERIC_DEPTH) instead of repeating an O(body
  // size) walk per candidate per iteration.
  type FnInfo = {
    paramNames: Set<string>;
    returns: ts.Expression[];
    sawBareReturn: boolean;
    paramsAllNumeric: boolean;
  };
  const fnInfo = new Map<string, FnInfo>();
  for (const [fnName, fnDecl] of candidates) {
    const paramNames = new Set<string>();
    let paramsAllNumeric = true;
    for (const p of fnDecl.parameters) {
      if (ts.isIdentifier(p.name)) paramNames.add(p.name.text);
      const pt = ctx.checker.getTypeAtLocation(p);
      const isNumericTs =
        (pt.flags &
          (ts.TypeFlags.Number | ts.TypeFlags.NumberLiteral | ts.TypeFlags.Boolean | ts.TypeFlags.BooleanLiteral)) !==
        0;
      const isImplicitAny = !p.type && (pt.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
      if (!isNumericTs && !isImplicitAny) {
        paramsAllNumeric = false;
      }
    }
    const returns: ts.Expression[] = [];
    let sawBareReturn = false;
    if (fnDecl.body) {
      const visit = (node: ts.Node): void => {
        // Don't descend into nested function-likes — their returns belong to them
        if (
          node !== fnDecl &&
          (ts.isFunctionDeclaration(node) ||
            ts.isFunctionExpression(node) ||
            ts.isArrowFunction(node) ||
            ts.isMethodDeclaration(node) ||
            ts.isAccessor(node) ||
            ts.isConstructorDeclaration(node))
        ) {
          return;
        }
        if (ts.isReturnStatement(node)) {
          if (node.expression) {
            returns.push(node.expression);
          } else {
            sawBareReturn = true;
          }
        }
        forEachChild(node, visit);
      };
      forEachChild(fnDecl.body, visit);
    }
    fnInfo.set(fnName, { paramNames, returns, sawBareReturn, paramsAllNumeric });
  }

  // Iterate to fixpoint: drop candidates that fail under the current set.
  // The set can only shrink, so the loop terminates in <= candidates.size
  // iterations. Each iteration is O(candidates × cached returns ×
  // MAX_NUMERIC_DEPTH) — no repeated AST walks of the function bodies.
  let changed = true;
  let safety = candidates.size + 1;
  while (changed && safety-- > 0) {
    changed = false;
    for (const fnName of candidates.keys()) {
      if (!numeric.has(fnName)) continue;
      const info = fnInfo.get(fnName)!;
      if (!info.paramsAllNumeric || info.sawBareReturn || info.returns.length === 0) {
        numeric.delete(fnName);
        changed = true;
        continue;
      }
      let allNumeric = true;
      for (const r of info.returns) {
        if (!isNumericExpr(r, info.paramNames)) {
          allNumeric = false;
          break;
        }
      }
      if (!allNumeric) {
        numeric.delete(fnName);
        changed = true;
      }
    }
  }

  // (#2795) Among the numeric kernels, identify the PURELY-BOOLEAN ones — every
  // `return` is a boolean-valued expression (literal `true`/`false`, a
  // comparison, `!x`, a boolean `&&`/`||`/`?:`, or a recursive call to another
  // boolean kernel). These promote to a boolean-BRANDED i32 instead of f64, so
  // when the result is later boxed into an `any`/externref slot (e.g. passed to
  // the host `console.log` of a mutually-recursive predicate) it crosses as the
  // JS boolean `true`/`false` rather than the number 1/0 (#2795 closures/10-mutual).
  // A boolean kernel's body still produces i32 0/1, so the brand is the only
  // change; arithmetic kernels keep f64.
  const isBooleanExpr = (expr: ts.Expression, depth = 0): boolean => {
    if (depth > MAX_NUMERIC_DEPTH) return false;
    if (ts.isParenthesizedExpression(expr)) return isBooleanExpr(expr.expression, depth + 1);
    if (ts.isAsExpression(expr) || ts.isTypeAssertionExpression(expr) || ts.isNonNullExpression(expr)) {
      return isBooleanExpr(expr.expression, depth + 1);
    }
    if (expr.kind === ts.SyntaxKind.TrueKeyword || expr.kind === ts.SyntaxKind.FalseKeyword) return true;
    if (ts.isPrefixUnaryExpression(expr)) {
      // `!x` is boolean regardless of operand type.
      return expr.operator === ts.SyntaxKind.ExclamationToken;
    }
    if (ts.isBinaryExpression(expr)) {
      const op = expr.operatorToken.kind;
      // Relational / equality operators yield boolean.
      if (
        op === ts.SyntaxKind.LessThanToken ||
        op === ts.SyntaxKind.LessThanEqualsToken ||
        op === ts.SyntaxKind.GreaterThanToken ||
        op === ts.SyntaxKind.GreaterThanEqualsToken ||
        op === ts.SyntaxKind.EqualsEqualsToken ||
        op === ts.SyntaxKind.ExclamationEqualsToken ||
        op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
        op === ts.SyntaxKind.InstanceOfKeyword ||
        op === ts.SyntaxKind.InKeyword
      ) {
        return true;
      }
      // `&&` / `||` are boolean only when BOTH operands are boolean.
      if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken) {
        return isBooleanExpr(expr.left, depth + 1) && isBooleanExpr(expr.right, depth + 1);
      }
      return false;
    }
    if (ts.isConditionalExpression(expr)) {
      return isBooleanExpr(expr.whenTrue, depth + 1) && isBooleanExpr(expr.whenFalse, depth + 1);
    }
    if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression)) {
      // A recursive/mutual call to a fellow boolean kernel stays boolean.
      if (boolean.has(expr.expression.text)) return true;
      // `Boolean(x)` yields boolean.
      if (expr.expression.text === "Boolean") return true;
      return false;
    }
    return false;
  };

  // Boolean kernels are a subset of the numeric kernels — seed with all of them
  // and shrink by the same fixpoint discipline (a candidate stays boolean only
  // while every return is boolean under the optimistic assumption that the other
  // candidates are boolean too).
  const boolean = new Set<string>(numeric);
  let bChanged = true;
  let bSafety = boolean.size + 1;
  while (bChanged && bSafety-- > 0) {
    bChanged = false;
    for (const fnName of [...boolean]) {
      const info = fnInfo.get(fnName)!;
      if (!info.returns.every((r) => isBooleanExpr(r))) {
        boolean.delete(fnName);
        bChanged = true;
      }
    }
  }

  const result = new Map<string, ValType>();
  for (const fnName of numeric) {
    result.set(fnName, boolean.has(fnName) ? { kind: "i32", boolean: true } : { kind: "f64" });
  }
  return result;
}

/**
 * Pre-pass: detect empty object literals (`var obj = {}`) that later receive
 * property assignments (`obj.prop = val`) and record the extra properties so
 * that ensureStructForType creates a struct with the correct fields.
 *
 * This runs *before* collectDeclarations so the struct type is correct from
 * the start.
 */
export function collectEmptyObjectWidening(
  ctx: CodegenContext,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
): void {
  // Scan all statements (top-level and inside function bodies)
  function scanStatements(stmts: readonly ts.Statement[]): void {
    for (const stmt of stmts) {
      // Look for var/let/const declarations with empty object literal initializer
      if (ts.isVariableStatement(stmt)) {
        for (const decl of stmt.declarationList.declarations) {
          if (!ts.isIdentifier(decl.name)) continue;
          if (!decl.initializer || !ts.isObjectLiteralExpression(decl.initializer)) continue;
          if (decl.initializer.properties.length > 0) continue;

          // Found `var X = {}` — now scan siblings for `X.prop = val`
          const varName = decl.name.text;
          const extraProps: { name: string; type: ValType }[] = [];
          const seenProps = new Set<string>();

          // Scan all following statements in the same block for property assignments
          collectPropsFromStatements(checker, ctx, stmts, varName, extraProps, seenProps);

          // (#2584/#2849/#2944) If this var is ALSO the subject of any
          // `$Object`-hash-only consumer (bracket read/write, `in`, Object.keys
          // / values / entries / GOPD / GOPN / assign, for-in), a widened closed
          // struct would be invisible to that consumer (`o.a=7; o["a"]` → 0).
          // Mark it poisoned so widening is suppressed below and the receiver
          // stays a `$Object`. Scan the whole enclosing statement list (the same
          // tree `collectPropsFromStatements` walks).
          //
          // History: originally `ctx.standalone`-gated (#2584) on the assumption
          // "host keeps the struct fast path via the live-mirror Proxy". #2849
          // dropped the gate (the Proxy does NOT bridge the for-in-write →
          // static-struct-read divergence, so host mis-read `getOptions`-shaped
          // objects). That extension alone REGRESSED compiled-acorn to a uniform
          // null-deref (#2937) because the poison was honored only at THIS
          // widening decision, while in JS-mode sources the checker's EVOLVED
          // type for the var still resolved to a colliding `__anon` struct at
          // the local/receiver/return/field positions — so it was reverted
          // (#2462). Re-landed here TOGETHER with the #2944 escape discipline:
          // the poison branch below records the var's evolved checker type in
          // `objectHashConsumerTypes`, and resolveWasmType / ensureStructForType
          // / resolveStructName refuse struct resolution for it, keeping the
          // value externref/host-MOP through every escape. Both constraints now
          // hold: the #2849 host arms pass AND compiled-acorn parses.
          for (const s of stmts) {
            markObjectHashConsumers(s, varName, ctx.objectHashConsumerVars);
          }

          // (#2372) Standalone: if any `Object.defineProperty(varName, …)` on
          // this receiver used a *dynamic* (non-inline-literal) descriptor, the
          // struct-widening fast path is unsound — the dynamic define is applied
          // through the native `__obj_define_from_desc` `$Object` runtime, but a
          // widened struct would make the read-back `varName.key` lower to
          // `struct.get` against a different object (returns 0). Suppress
          // widening entirely for such receivers so they stay on the `$Object`
          // representation and writes + reads route through the native runtime
          // consistently. (`collectPropsFromStatements` sets the poison flag
          // above, before this decision point.) Host mode is unaffected — it
          // keeps the struct fast path via the live-mirror Proxy writeback.
          if (ctx.dynamicDescriptorWidenVars.has(varName)) {
            continue;
          }

          // (#2584) Suppress widening when a $Object-hash consumer was found
          // above — the var stays a `$Object` so bracket/`in`/keys/GOPD see the
          // same representation the dot-writes land in.
          if (ctx.objectHashConsumerVars.has(varName)) {
            // (#2937) Suppressing the widening pre-pass is NOT enough in a
            // JS-mode source file: the checker EVOLVES `var o = {}` through its
            // later static-named writes into an anonymous object type WITH
            // those props, and `resolveWasmType`/`ensureStructForType` would
            // independently register that evolved type as a closed `__anon_N`
            // struct — typing the local (and the var's every flow position:
            // returns, class fields, receivers) as `(ref null __anon_N)` while
            // the poisoned initializer builds a host plain object. The
            // declaration's guarded cast then stores ref.null and every static
            // read null-derefs (the compiled-acorn `getOptions` uniform throw).
            // Record the var's EVOLVED checker type so struct resolution
            // refuses it and the var stays externref / host-MOP end to end.
            //
            // Scope guards keep everything else byte-identical:
            //   - `!ctx.standalone`: standalone keeps its pre-existing codegen
            //     byte-identical (its matching read-back gap for this shape is
            //     tracked separately; see #2849's follow-up note).
            //   - skip `any` (singleton type object shared by all any-typed
            //     vars — same hazard as the anonTypeMap guard below).
            //   - a 0-props (TS-mode, non-evolved `{}`) type is added ONLY when
            //     its provenance is THIS var's own initializer literal
            //     (`symbol.declarations[0] === decl.initializer`). The widened
            //     literal type is a fresh per-var instance (measured — two `{}`
            //     vars get distinct instances), but the type of a `: {}`
            //     ANNOTATION is an interned instance SHARED by every var so
            //     annotated — poisoning it would demote unrelated vars. The
            //     provenance check admits the safe per-var case and rejects the
            //     shared one.
            //
            // (#2944 residual) The 0-props TS-mode case MUST be poisoned too —
            // "already resolves to externref" does NOT hold for it: the
            // signature pre-pass `ensureStructForType(returnType)` on a function
            // that RETURNS the poisoned var registers the SAME 0-props ts.Type
            // as an EMPTY anon struct ("empty objects get an empty struct"), so
            // the local/return/field slots type `(ref null $__anon_N)`, the `{}`
            // host `$Object` fails the decl-init cast, and the var is null from
            // the first instruction — the acorn `Parser`/`getOptions` escape
            // shape in TS-mode typing (tests/issue-2944.test.ts).
            if (!ctx.standalone) {
              const vt = checker.getTypeAtLocation(decl.name);
              if (
                !(vt.flags & ts.TypeFlags.Any) &&
                (vt.getProperties().length > 0 || vt.symbol?.declarations?.[0] === decl.initializer)
              ) {
                ctx.objectHashConsumerTypes.add(vt);
              }
            }
            continue;
          }

          if (extraProps.length > 0) {
            ctx.widenedTypeProperties.set(varName, extraProps);

            // Register the struct type now so that collectDeclarations
            // can resolve the variable type to a struct ref instead of externref
            const fields: FieldDef[] = extraProps.map((wp) => ({
              name: wp.name,
              type: wp.type,
              mutable: true,
            }));
            const structName = `__anon_${ctx.anonTypeCounter++}`;
            const typeIdx = ctx.mod.types.length;
            ctx.mod.types.push({
              kind: "struct",
              name: structName,
              fields,
            } as StructTypeDef);
            ctx.structMap.set(structName, typeIdx);
            ctx.typeIdxToStructName.set(typeIdx, structName);
            ctx.structFields.set(structName, fields);
            // Map variable name to struct name for later lookup
            ctx.widenedVarStructMap.set(varName, structName);
            // Also try to map TS types (may not match later due to type identity)
            // Skip `any` — it's a singleton type object shared by all any-typed vars,
            // so registering it would cause every any-typed var to resolve to this struct.
            const varType = checker.getTypeAtLocation(decl.name);
            if (!(varType.flags & ts.TypeFlags.Any)) {
              ctx.anonTypeMap.set(varType, structName);
            }
            const initType = checker.getTypeAtLocation(decl.initializer);
            if (!(initType.flags & ts.TypeFlags.Any)) {
              ctx.anonTypeMap.set(initType, structName);
            }
          }
        }
      }
      // Recurse into function bodies
      if (ts.isFunctionDeclaration(stmt) && stmt.body) {
        scanStatements(stmt.body.statements);
      }
      // Recurse into try/catch blocks (wrapTest wraps test bodies in try blocks)
      if (ts.isTryStatement(stmt)) {
        scanStatements(stmt.tryBlock.statements);
        if (stmt.catchClause) {
          scanStatements(stmt.catchClause.block.statements);
        }
        if (stmt.finallyBlock) {
          scanStatements(stmt.finallyBlock.statements);
        }
      }
    }
  }

  scanStatements(sourceFile.statements);
}

/**
 * (#2837) Detection pre-pass: mark variables initialized by a NON-EMPTY object
 * literal that later receive an OUT-OF-SHAPE property write, so `compileObjectLiteral`
 * (literals.ts) routes them through the recursive externref `$Object` builder
 * instead of a closed struct (whose unknown-field writes lower to `drop`).
 *
 * Two trigger rules (mirroring the issue's WAT-grounded isolation):
 *   - **Direct:**  `V.k = …` where `k` is NOT a property name in `V`'s literal shape.
 *   - **Nested (the acorn trigger):** any assignment whose LHS is a property-access
 *     chain rooted at `V` with depth ≥ 2 (`V.a.b… = …`) — e.g.
 *     `prototypeAccessors.inFunction.get = fn` onto the nested `{configurable:true}`
 *     descriptor. Conservative over-approximation: a depth-≥2 write to an
 *     already-in-shape nested field also marks `V` (it is being deep-mutated;
 *     growable is correct, only marginally slower).
 *
 * Consumer-safety guard (avoids the #1897 closed-struct-consumer regression):
 * a marked var becomes an externref `$Object`, so a consumer that requires the
 * closed-struct representation (a `struct.get` numeric read used in arithmetic, or
 * a pass into a CONCRETE nominal-struct-typed parameter / return / assignment)
 * would null-deref or mis-coerce. When such a consumer is detected, do NOT mark
 * (leave the pre-existing closed-struct lowering — the var keeps working for its
 * struct consumers; it just retains the dropped-write bug, which is acceptable —
 * it is not the acorn blocker). When in doubt, prefer NOT marking.
 *
 * Runs BEFORE collectDeclarations (alongside `collectEmptyObjectWidening`) so the
 * variable's representation decision is made before its type is resolved.
 */
export function collectGrowableObjectLiterals(
  ctx: CodegenContext,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
): void {
  // A literal property name we can build onto a $Object (data prop, statically-known key).
  function literalShapeNames(obj: ts.ObjectLiteralExpression): Set<string> | null {
    const names = new Set<string>();
    for (const p of obj.properties) {
      if (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) {
        const nm = p.name;
        if (ts.isIdentifier(nm) || ts.isStringLiteral(nm) || ts.isNumericLiteral(nm)) {
          names.add(nm.text);
        } else {
          return null; // computed / symbol key — externref builder may decline; skip marking
        }
      } else {
        return null; // spread / method / accessor — not a pure data literal
      }
    }
    return names;
  }

  // Resolve a property-access chain's root identifier + depth. Returns null if the
  // base is not ultimately a plain identifier (e.g. a call result).
  function chainRoot(pae: ts.PropertyAccessExpression): { root: string; depth: number } | null {
    let e: ts.Expression = pae;
    let depth = 0;
    while (ts.isPropertyAccessExpression(e)) {
      depth++;
      e = e.expression;
    }
    if (ts.isIdentifier(e)) return { root: e.text, depth };
    return null;
  }

  // Does a contextual type at a use site REQUIRE the closed-struct representation?
  // True only for a CONCRETE nominal struct (named own properties, not any/unknown/
  // `object`, not a pure string-index dictionary). any/object/index-sig consumers
  // (e.g. `Object.defineProperties`' PropertyDescriptorMap param) are SAFE.
  function typeRequiresStruct(t: ts.Type | undefined): boolean {
    if (!t) return false;
    if (t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.NonPrimitive)) return false;
    if (t.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike)) return false;
    // A pure string-index dictionary (no named own props) is an open object → safe.
    const props = t.getProperties();
    const hasStringIndex = !!checker.getIndexInfoOfType(t, ts.IndexKind.String);
    if (props.length === 0 && hasStringIndex) return false;
    if (props.length === 0) return false; // empty/object-ish → safe
    return true; // concrete shape with named props → struct consumer
  }

  function scanStatements(stmts: readonly ts.Statement[]): void {
    for (const stmt of stmts) {
      if (ts.isVariableStatement(stmt)) {
        for (const decl of stmt.declarationList.declarations) {
          if (!ts.isIdentifier(decl.name)) continue;
          if (!decl.initializer || !ts.isObjectLiteralExpression(decl.initializer)) continue;
          if (decl.initializer.properties.length === 0) continue; // empty handled by widening
          const varName = decl.name.text;
          const shape = literalShapeNames(decl.initializer);
          if (!shape) continue; // not a pure data literal → skip (externref builder would decline)

          let grows = false;
          let poisoned = false;

          const visit = (node: ts.Node): void => {
            // Out-of-shape write rooted at varName.
            if (
              ts.isBinaryExpression(node) &&
              node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
              ts.isPropertyAccessExpression(node.left)
            ) {
              const info = chainRoot(node.left);
              if (info && info.root === varName) {
                if (info.depth >= 2) {
                  grows = true; // nested deep-mutation (the acorn descriptor case)
                } else if (info.depth === 1 && !shape.has(node.left.name.text)) {
                  grows = true; // direct out-of-shape field add
                }
              }
            }
            // Consumer-safety: a numeric/arithmetic read of a field off varName needs
            // the struct `struct.get` f64 contract (#1897) → poison.
            if (
              ts.isBinaryExpression(node) &&
              isArithmeticOperator(node.operatorToken.kind) &&
              (isFieldReadOf(node.left, varName) || isFieldReadOf(node.right, varName))
            ) {
              poisoned = true;
            }
            if (
              ts.isPrefixUnaryExpression(node) &&
              (node.operator === ts.SyntaxKind.MinusToken || node.operator === ts.SyntaxKind.PlusToken) &&
              isFieldReadOf(node.operand, varName)
            ) {
              poisoned = true;
            }
            // Consumer-safety: varName flows into a CONCRETE-struct-typed position
            // (call/new argument, return, or assignment target) → poison.
            if (ts.isIdentifier(node) && node.text === varName && isValueUseOfIdentifier(node)) {
              if (typeRequiresStruct(checker.getContextualType(node))) {
                poisoned = true;
              }
            }
            // (#2837 regression fix) Consumer-safety: `delete V.k`, element/bracket
            // access `V[expr]`, and `for (k in V)` lower against V's STATIC struct
            // type (`ref.cast` to the inferred struct + `struct.set`/enumerate).
            // Routing V to externref `$Object` would make those casts `illegal cast`
            // (the consumers don't consult `externrefAccessorVars`). Such objects are
            // ALREADY handled correctly by the existing dynamic-consumer machinery
            // (they passed pre-fix), so do NOT mark them growable — leave them on the
            // struct path, byte-identical. acorn's `prototypeAccessors` has none of
            // these (consumed only by `Object.defineProperties`), so it stays marked.
            if (
              ts.isDeleteExpression(node) &&
              ts.isPropertyAccessExpression(node.expression) &&
              ts.isIdentifier(node.expression.expression) &&
              node.expression.expression.text === varName
            ) {
              poisoned = true;
            }
            if (
              ts.isElementAccessExpression(node) &&
              ts.isIdentifier(node.expression) &&
              node.expression.text === varName
            ) {
              poisoned = true;
            }
            if (ts.isForInStatement(node) && ts.isIdentifier(node.expression) && node.expression.text === varName) {
              poisoned = true;
            }
            forEachChild(node, visit);
          };
          for (const s of stmts) visit(s);
          if (grows && !poisoned) {
            ctx.growableObjectLiteralVars.add(varName);
          }
        }
      }
      if (ts.isFunctionDeclaration(stmt) && stmt.body) {
        scanStatements(stmt.body.statements);
      }
      if (ts.isTryStatement(stmt)) {
        scanStatements(stmt.tryBlock.statements);
        if (stmt.catchClause) scanStatements(stmt.catchClause.block.statements);
        if (stmt.finallyBlock) scanStatements(stmt.finallyBlock.statements);
      }
    }
  }

  scanStatements(sourceFile.statements);
}

/** (#2837) `V.field` (depth-1 property read) where the chain root is `varName`. */
function isFieldReadOf(expr: ts.Expression, varName: string): boolean {
  if (!ts.isPropertyAccessExpression(expr)) return false;
  return ts.isIdentifier(expr.expression) && expr.expression.text === varName;
}

/** (#2837) Arithmetic binary operators whose operands need the f64 struct contract. */
function isArithmeticOperator(kind: ts.SyntaxKind): boolean {
  return (
    kind === ts.SyntaxKind.MinusToken ||
    kind === ts.SyntaxKind.AsteriskToken ||
    kind === ts.SyntaxKind.SlashToken ||
    kind === ts.SyntaxKind.PercentToken ||
    kind === ts.SyntaxKind.AsteriskAsteriskToken
  );
}

/** (#2837) The identifier is used as a value (arg / return / RHS), not as an
 * assignment target or the base of its own property-write. */
function isValueUseOfIdentifier(id: ts.Identifier): boolean {
  const p = id.parent;
  if (ts.isCallExpression(p) || ts.isNewExpression(p)) {
    return (p.arguments?.indexOf(id) ?? -1) >= 0;
  }
  if (ts.isReturnStatement(p)) return true;
  if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken && p.right === id) {
    return true;
  }
  return false;
}

/** Returns true if an Object.defineProperty descriptor ObjectLiteral is an accessor descriptor
 * with an ACTUAL function getter or setter that needs the sidecar/extern path.
 * Descriptors with `get: undefined` or `set: undefined` are NOT treated as accessor descriptors —
 * they are widened like data descriptors so the property appears in for-in and hasOwnProperty
 * (matching baseline behavior where all Object.defineProperty targets are widened). (#929) */
function isAccessorDescriptor(descArg: ts.Expression): boolean {
  if (!ts.isObjectLiteralExpression(descArg)) return false;
  for (const prop of descArg.properties) {
    // Method shorthand: get() {...} or set(v) {...} — always a real accessor
    if (ts.isMethodDeclaration(prop) && prop.name && ts.isIdentifier(prop.name)) {
      if (prop.name.text === "get" || prop.name.text === "set") return true;
    }
    // Property assignment: get: <expr> or set: <expr>
    // Only treat as accessor if the value is an actual function (not `undefined` or other non-callable)
    if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
      if (prop.name.text === "get" || prop.name.text === "set") {
        const init = prop.initializer;
        if (ts.isFunctionExpression(init) || ts.isArrowFunction(init)) return true;
        // Named identifier that is NOT `undefined` or `null` — may be a function variable
        if (ts.isIdentifier(init) && init.text !== "undefined" && init.text !== "null") return true;
      }
    }
  }
  return false;
}

/**
 * (#2584) Recursively walk `node` and poison `varName` in `poisonSet` if it
 * appears as the subject of any `$Object`-hash-only operation — i.e. an access
 * form that, in standalone, reads or enumerates the native `$Object` open hash
 * rather than a widened WasmGC struct field:
 *
 *   - `varName[<expr>]` — ElementAccessExpression with the var as receiver
 *     (covers both `o["a"]` read and `o[k]` write).
 *   - `<key> in varName` — `in` BinaryExpression with the var on the right.
 *   - `Object.keys/values/entries/getOwnPropertyDescriptor/getOwnPropertyNames(varName)`
 *     and `Object.assign(varName, …)` / `Object.assign(…, varName)` — the var as
 *     any relevant argument.
 *   - `for (… in varName)` — ForInStatement enumerating the var.
 *
 * A single match is enough; the receiver then stays a `$Object` so every access
 * form (including the dot-writes) targets the same representation. Name-based,
 * matching the existing widening pre-pass (aliasing is a shared, documented
 * limitation — see the issue's `## Deferred`).
 */
function markObjectHashConsumers(node: ts.Node, varName: string, poisonSet: Set<string>): void {
  const isVarRef = (n: ts.Node): boolean => ts.isIdentifier(n) && n.text === varName;

  const OBJECT_HASH_METHODS = new Set([
    "keys",
    "values",
    "entries",
    "getOwnPropertyDescriptor",
    "getOwnPropertyDescriptors",
    "getOwnPropertyNames",
    "assign",
  ]);

  const visit = (n: ts.Node): void => {
    // varName[<expr>]  (bracket read or write)
    if (ts.isElementAccessExpression(n) && isVarRef(n.expression)) {
      poisonSet.add(varName);
    }
    // <key> in varName
    else if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.InKeyword && isVarRef(n.right)) {
      poisonSet.add(varName);
    }
    // Object.<hashMethod>(… varName …)
    else if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      ts.isIdentifier(n.expression.expression) &&
      n.expression.expression.text === "Object" &&
      ts.isIdentifier(n.expression.name) &&
      OBJECT_HASH_METHODS.has(n.expression.name.text) &&
      n.arguments.some((a) => isVarRef(a))
    ) {
      poisonSet.add(varName);
    }
    // for (… in varName)
    else if (ts.isForInStatement(n) && isVarRef(n.expression)) {
      poisonSet.add(varName);
    }
    ts.forEachChild(n, visit);
  };

  visit(node);
}

export function collectPropsFromStatements(
  checker: ts.TypeChecker,
  ctx: CodegenContext,
  stmts: readonly ts.Statement[],
  varName: string,
  extraProps: { name: string; type: ValType }[],
  seenProps: Set<string>,
): void {
  for (const s of stmts) {
    // ExpressionStatement: obj.prop = value
    if (ts.isExpressionStatement(s) && ts.isBinaryExpression(s.expression)) {
      const bin = s.expression;
      if (
        bin.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(bin.left) &&
        ts.isIdentifier(bin.left.expression) &&
        bin.left.expression.text === varName
      ) {
        const propName = bin.left.name.text;
        if (!seenProps.has(propName)) {
          seenProps.add(propName);
          // Infer wasm type from the RHS
          const rhsType = checker.getTypeAtLocation(bin.right);
          const wasmType = resolveWasmType(ctx, rhsType);
          extraProps.push({ name: propName, type: wasmType });
        }
      }
    }
    // Object.defineProperty(obj, "prop", { value: v }) — treat as obj.prop = v for widening
    if (ts.isExpressionStatement(s) && ts.isCallExpression(s.expression)) {
      const call = s.expression;
      if (
        ts.isPropertyAccessExpression(call.expression) &&
        ts.isIdentifier(call.expression.expression) &&
        call.expression.expression.text === "Object" &&
        ts.isIdentifier(call.expression.name) &&
        call.expression.name.text === "defineProperty" &&
        call.arguments.length >= 3
      ) {
        const objArg = call.arguments[0]!;
        const propArg = call.arguments[1]!;
        const descArg = call.arguments[2]!;
        if (ts.isIdentifier(objArg) && objArg.text === varName && ts.isStringLiteral(propArg)) {
          const propName = propArg.text;
          // (#2372) The struct-widening fast path only works when the
          // descriptor is a statically-resolvable inline object literal: the
          // define lowers to `struct.set` and the read-back to `struct.get` on
          // the SAME widened struct field. A *dynamic* descriptor (a variable /
          // call result) cannot be applied via `struct.set` — standalone routes
          // it to the native `__obj_define_from_desc` helper, which writes the
          // `$Object` open-hash runtime. If we widen the receiver to a struct
          // anyway, the read-back `o.x` lowers to `struct.get` against the
          // struct while the write landed in the `$Object` — different objects,
          // so the read returns 0. Mark this var as define-poisoned so the
          // widening is suppressed for it (below): the receiver then stays on
          // the `$Object` representation and BOTH the dynamic write and the
          // read route through the native runtime consistently. Host mode keeps
          // the struct fast path (the host `__defineProperty_desc` import
          // reflects back through the live-mirror Proxy onto the struct sidecar).
          if (ctx.standalone && !ts.isObjectLiteralExpression(descArg)) {
            ctx.dynamicDescriptorWidenVars.add(varName);
          }
          if (!seenProps.has(propName)) {
            seenProps.add(propName);
            // Try to get value type from descriptor.value
            let wasmType: ValType = { kind: "externref" };
            if (ts.isObjectLiteralExpression(descArg)) {
              for (const prop of descArg.properties) {
                if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === "value") {
                  const rhsType = checker.getTypeAtLocation(prop.initializer);
                  wasmType = resolveWasmType(ctx, rhsType);
                  break;
                }
              }
            }
            extraProps.push({ name: propName, type: wasmType });
            ctx.widenedDefinePropertyKeys.add(`${varName}:${propName}`);
          }
        }
      }
    }
    // Also handle: const result = Object.defineProperty(obj, ...)
    if (ts.isVariableStatement(s)) {
      for (const decl of s.declarationList.declarations) {
        if (decl.initializer && ts.isCallExpression(decl.initializer)) {
          const call = decl.initializer;
          if (
            ts.isPropertyAccessExpression(call.expression) &&
            ts.isIdentifier(call.expression.expression) &&
            call.expression.expression.text === "Object" &&
            ts.isIdentifier(call.expression.name) &&
            call.expression.name.text === "defineProperty" &&
            call.arguments.length >= 3
          ) {
            const objArg = call.arguments[0]!;
            const propArg = call.arguments[1]!;
            const descArg = call.arguments[2]!;
            if (ts.isIdentifier(objArg) && objArg.text === varName && ts.isStringLiteral(propArg)) {
              const propName = propArg.text;
              if (!seenProps.has(propName)) {
                seenProps.add(propName);
                let wasmType: ValType = { kind: "externref" };
                if (ts.isObjectLiteralExpression(descArg)) {
                  for (const prop of descArg.properties) {
                    if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === "value") {
                      const rhsType = checker.getTypeAtLocation(prop.initializer);
                      wasmType = resolveWasmType(ctx, rhsType);
                      break;
                    }
                  }
                }
                extraProps.push({ name: propName, type: wasmType });
                ctx.widenedDefinePropertyKeys.add(`${varName}:${propName}`);
              }
            }
          }
        }
      }
    }
    // Recurse into compound statement bodies to find property assignments
    if (ts.isBlock(s)) {
      collectPropsFromStatements(checker, ctx, s.statements, varName, extraProps, seenProps);
    }
    if (ts.isIfStatement(s)) {
      if (ts.isBlock(s.thenStatement)) {
        collectPropsFromStatements(checker, ctx, s.thenStatement.statements, varName, extraProps, seenProps);
      }
      if (s.elseStatement && ts.isBlock(s.elseStatement)) {
        collectPropsFromStatements(checker, ctx, s.elseStatement.statements, varName, extraProps, seenProps);
      }
    }
    // Recurse into try/catch/finally blocks (wrapTest wraps test bodies in try blocks)
    if (ts.isTryStatement(s)) {
      collectPropsFromStatements(checker, ctx, s.tryBlock.statements, varName, extraProps, seenProps);
      if (s.catchClause) {
        collectPropsFromStatements(checker, ctx, s.catchClause.block.statements, varName, extraProps, seenProps);
      }
      if (s.finallyBlock) {
        collectPropsFromStatements(checker, ctx, s.finallyBlock.statements, varName, extraProps, seenProps);
      }
    }
    // Recurse into for/while/do-while/switch bodies
    if (
      ts.isForStatement(s) ||
      ts.isForInStatement(s) ||
      ts.isForOfStatement(s) ||
      ts.isWhileStatement(s) ||
      ts.isDoStatement(s)
    ) {
      if (ts.isBlock(s.statement)) {
        collectPropsFromStatements(checker, ctx, s.statement.statements, varName, extraProps, seenProps);
      }
    }
    if (ts.isSwitchStatement(s)) {
      for (const clause of s.caseBlock.clauses) {
        collectPropsFromStatements(checker, ctx, clause.statements, varName, extraProps, seenProps);
      }
    }
  }
}

/**
 * Apply shape inference: detect module-level variables used as array-like objects
 * and override their global types from externref/AnyValue to vec struct types.
 * Must be called after collectDeclarations (which registers module globals).
 */
export function applyShapeInference(ctx: CodegenContext, checker: ts.TypeChecker, sourceFile: ts.SourceFile): void {
  const shapes = collectShapes(checker, sourceFile);
  if (shapes.size === 0) return;

  for (const [varName, shape] of shapes) {
    const globalIdx = ctx.moduleGlobals.get(varName);
    if (globalIdx === undefined) continue;

    // Determine element type for the vec struct from the shape's numeric value type
    let elemType: ValType;
    let elemKey: string;
    if (shape.numericValueType === "number") {
      if (ctx.fast) {
        elemType = { kind: "i32" };
        elemKey = "i32";
      } else {
        elemType = { kind: "f64" };
        elemKey = "f64";
      }
    } else if (shape.numericValueType === "string") {
      elemType = { kind: "externref" };
      elemKey = "externref";
    } else {
      // Default to f64 for unknown numeric types
      if (ctx.fast) {
        elemType = { kind: "i32" };
        elemKey = "i32";
      } else {
        elemType = { kind: "f64" };
        elemKey = "f64";
      }
    }

    // Register or reuse the vec struct type
    const vecTypeIdx = getOrRegisterVecType(ctx, elemKey, elemType);
    const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);

    // Override the module global's type to ref_null of the vec struct
    const localIdx = localGlobalIdx(ctx, globalIdx);
    const globalDef = ctx.mod.globals[localIdx];
    if (globalDef) {
      const newType: ValType = { kind: "ref_null", typeIdx: vecTypeIdx };
      globalDef.type = newType;
      // Update initializer to ref.null of the vec type
      globalDef.init = [{ op: "ref.null", typeIdx: vecTypeIdx }];
    }

    // Record in shapeMap for use during compilation
    ctx.shapeMap.set(varName, { vecTypeIdx, arrTypeIdx, elemType });
  }
}

function bindingPatternParamNeedsWiden(p: ts.ParameterDeclaration): boolean {
  if (p.type || p.dotDotDotToken) return false;
  return ts.isArrayBindingPattern(p.name) || ts.isObjectBindingPattern(p.name);
}

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
      const paramType = ctx.checker.getTypeAtLocation(param);
      let wasmType: ValType = bindingPatternParamNeedsWiden(param)
        ? { kind: "externref" }
        : restBindingOverridesToExternref(param)
          ? { kind: "externref" }
          : resolveWasmType(ctx, paramType);
      if (param.initializer && wasmType.kind === "ref") {
        wasmType = { kind: "ref_null", typeIdx: wasmType.typeIdx };
      }
      if (
        !param.type &&
        paramType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown) &&
        (wasmType.kind === "externref" ||
          (wasmType.kind === "ref_null" && ctx.anyValueTypeIdx >= 0 && wasmType.typeIdx === ctx.anyValueTypeIdx))
      ) {
        let inferred = inferParamTypeFromCallSites(ctx, name, i, sourceFile);
        if (!inferred) inferred = inferParamTypeFromBody(ctx, stmt, i);
        if (inferred) wasmType = inferred;
      }
      params.push(wasmType);
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
        const paramType = ctx.checker.getTypeAtLocation(param);
        let wasmType: ValType = bindingPatternParamNeedsWiden(param)
          ? { kind: "externref" }
          : restBindingOverridesToExternref(param)
            ? { kind: "externref" }
            : resolveWasmType(ctx, paramType);
        if (param.initializer && wasmType.kind === "ref") {
          wasmType = { kind: "ref_null", typeIdx: wasmType.typeIdx };
        }
        if (
          !param.type &&
          paramType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown) &&
          (wasmType.kind === "externref" ||
            (wasmType.kind === "ref_null" && ctx.anyValueTypeIdx >= 0 && wasmType.typeIdx === ctx.anyValueTypeIdx))
        ) {
          let inferred = inferParamTypeFromCallSites(ctx, name, i, sourceFile);
          if (!inferred) inferred = inferParamTypeFromBody(ctx, stmt, i);
          if (inferred) wasmType = inferred;
        }
        params.push(wasmType);
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
        const cd = extractConstantDefault(param.initializer, params[i]!);
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
      return [{ op: "f32.const", value: 0 } as Instr];
    case "i32":
      return [{ op: "i32.const", value: 0 }];
    case "i64":
      return [{ op: "i64.const", value: 0n }];
    case "externref":
    case "ref_extern":
      return [{ op: "ref.null.extern" } as Instr];
    case "eqref":
    case "anyref":
      return [{ op: "ref.null.eq" } as Instr];
    case "funcref":
      return [{ op: "ref.null.func" } as Instr];
    case "ref_null":
      return [{ op: "ref.null", typeIdx: returnType.typeIdx }];
    case "ref":
      return [{ op: "ref.null", typeIdx: returnType.typeIdx }, { op: "ref.as_non_null" } as Instr];
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

      // A binding-pattern parameter with a rest element and no type annotation
      // (e.g. `function f([...r])` or `function f({...x})`) infers as `{}` or
      // `{ [k: string]: any }` in TypeScript, which resolveWasmType maps to a
      // degenerate struct (single-field cell or empty struct). Callers that
      // pass an array/object to such a param fail the ref.test cast and
      // receive ref.null — breaking destructuring inside the function. Force
      // externref so the conversion paths in destructureParam{Array,Object}
      // handle the incoming value correctly.
      const restBindingOverridesToExternref = (p: ts.ParameterDeclaration): boolean => {
        if (p.type || p.dotDotDotToken) return false;
        if (ts.isArrayBindingPattern(p.name)) {
          return p.name.elements.some((e) => !ts.isOmittedExpression(e) && !!e.dotDotDotToken);
        }
        if (ts.isObjectBindingPattern(p.name)) {
          return p.name.elements.some((e) => !!e.dotDotDotToken);
        }
        return false;
      };

      // An unannotated binding-pattern parameter — `function f([x, y])` or
      // `function f({a, b})` — must route through the externref destructure path
      // so that the iterator protocol drives element extraction (spec
      // §13.3.3.6 IteratorBindingInitialization). Without this widening the
      // param compiles to a tuple struct signature and `f(generator)` silently
      // skips the iterator's `.next()`. Mirrors closures.ts:905 for arrows /
      // function-expressions. Skip when the user wrote an explicit type
      // annotation — they asked for the tuple-struct specialization. (#862)
      const bindingPatternParamNeedsWiden = (p: ts.ParameterDeclaration): boolean => {
        if (p.type || p.dotDotDotToken) return false;
        return ts.isArrayBindingPattern(p.name) || ts.isObjectBindingPattern(p.name);
      };

      if (isGenerator) {
        // Generator functions: parameters are compiled normally, return is externref
        params = [];
        for (let i = 0; i < stmt.parameters.length; i++) {
          const param = stmt.parameters[i]!;
          const paramType = ctx.checker.getTypeAtLocation(param);
          let wasmType: ValType = bindingPatternParamNeedsWiden(param)
            ? { kind: "externref" }
            : restBindingOverridesToExternref(param)
              ? { kind: "externref" }
              : resolveWasmType(ctx, paramType);
          // If the parameter has a default value and is a non-null ref type,
          // widen to ref_null so callers can pass ref.null as a sentinel for "use default"
          if (param.initializer && wasmType.kind === "ref") {
            wasmType = { kind: "ref_null", typeIdx: (wasmType as { kind: "ref"; typeIdx: number }).typeIdx };
          }
          // Infer untyped any params from call sites (same as non-generator path)
          if (
            !param.type &&
            paramType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown) &&
            (wasmType.kind === "externref" ||
              (wasmType.kind === "ref_null" &&
                ctx.anyValueTypeIdx >= 0 &&
                (wasmType as { typeIdx: number }).typeIdx === ctx.anyValueTypeIdx))
          ) {
            let inferred = inferParamTypeFromCallSites(ctx, name, i, sourceFile);
            if (!inferred) {
              inferred = inferParamTypeFromBody(ctx, stmt, i);
            }
            if (inferred) {
              wasmType = inferred;
            }
          }
          params.push(wasmType);
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
            const paramType = ctx.checker.getTypeAtLocation(param);
            let wasmType: ValType = bindingPatternParamNeedsWiden(param)
              ? { kind: "externref" }
              : restBindingOverridesToExternref(param)
                ? { kind: "externref" }
                : resolveWasmType(ctx, paramType);
            // If the parameter has a default value and is a non-null ref type,
            // widen to ref_null so callers can pass ref.null as a sentinel for "use default"
            if (param.initializer && wasmType.kind === "ref") {
              wasmType = { kind: "ref_null", typeIdx: (wasmType as { kind: "ref"; typeIdx: number }).typeIdx };
            }
            // If the parameter has no explicit type annotation and resolved to
            // externref (from `any`), try to infer a concrete type from call sites.
            if (
              !param.type &&
              paramType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown) &&
              (wasmType.kind === "externref" ||
                (wasmType.kind === "ref_null" &&
                  ctx.anyValueTypeIdx >= 0 &&
                  (wasmType as { typeIdx: number }).typeIdx === ctx.anyValueTypeIdx))
            ) {
              let inferred = inferParamTypeFromCallSites(ctx, name, i, sourceFile);
              // #1121: Body-usage fallback. If no internal callers exist
              // (e.g. exported entrypoint `function run(n) { return fib(n); }`)
              // but the body still uses the param numerically, infer f64.
              if (!inferred) {
                inferred = inferParamTypeFromBody(ctx, stmt, i);
              }
              if (inferred) {
                wasmType = inferred;
              }
            }
            params.push(wasmType);
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
            const cd = extractConstantDefault(param.initializer, params[i]!);
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
    const fnIdx = ctx.funcMap.get(name);
    if (fnIdx !== undefined && fnIdx !== ctx.jsStringImports.get(name)) return; // shadowed by a user function
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
    if (!decl.initializer || !ts.isObjectLiteralExpression(decl.initializer)) return false;
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
      while (ts.isParenthesizedExpression(expr)) expr = expr.expression;
      if (ts.isNewExpression(expr) || ts.isCallExpression(expr)) {
        ctx.moduleInitStatements.push(stmt);
        continue;
      }
      if (ts.isPrefixUnaryExpression(expr) || ts.isPostfixUnaryExpression(expr)) {
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
        //   - (#3049 Layer 1) DIRECT `F.prototype = …` is now ALSO kept for
        //     host/GC. The old exclusion claimed the compile-time
        //     fnctor-prototype lift consumes it, but
        //     `tryCompileFnctorPrototypeAssign` opens with
        //     `if (!ctx.standalone) return undefined` — the lift is
        //     STANDALONE-ONLY, so in host mode nothing consumed the statement
        //     and it was silently elided. `F.prototype` reads then fell back
        //     to the auto-vivified #1712 sidecar object (non-null but
        //     empty), dropping the assigned prototype object and its whole
        //     chain. This elision is what failed the Iterator-helper
        //     `this-plain-iterator` cluster: the test262-runner harness shim
        //     `Iterator.prototype = getPrototypeOf(getPrototypeOf(
        //     [][Symbol.iterator]()))` never ran. No double-apply is
        //     possible in host mode; standalone keeps its own #2660 S2 arm
        //     above and stays byte-identical.
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

export function collectInterface(ctx: CodegenContext, decl: ts.InterfaceDeclaration): void {
  const name = decl.name.text;
  const fields: FieldDef[] = [];

  for (const member of decl.members) {
    if (ts.isPropertySignature(member) && member.name) {
      const memberName = (member.name as ts.Identifier).text;
      const memberType = ctx.checker.getTypeAtLocation(member);
      const wasmType = mapTsTypeToWasm(memberType, ctx.checker);
      fields.push({
        name: memberName,
        type: wasmType,
        mutable: true,
      });
    }
  }

  const typeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name,
    fields,
  } as StructTypeDef);
  ctx.structMap.set(name, typeIdx);
  ctx.typeIdxToStructName.set(typeIdx, name);
  ctx.structFields.set(name, fields);
}

/**
 * After all interfaces and type aliases are collected, re-resolve field types
 * that were initially mapped to externref but should be ref $struct.
 * This handles cross-references between interfaces regardless of declaration order.
 */
export function resolveStructFieldTypes(ctx: CodegenContext, sourceFile: ts.SourceFile): void {
  for (const stmt of sourceFile.statements) {
    if (!ts.isInterfaceDeclaration(stmt) && !ts.isTypeAliasDeclaration(stmt)) continue;

    const name = ts.isInterfaceDeclaration(stmt) ? stmt.name.text : stmt.name.text;
    const fields = ctx.structFields.get(name);
    const structTypeIdx = ctx.structMap.get(name);
    if (!fields || structTypeIdx === undefined) continue;

    let changed = false;
    for (let i = 0; i < fields.length; i++) {
      const field = fields[i]!;
      if (field.type.kind !== "externref") continue;

      // Try to re-resolve using resolveWasmType which knows about structs
      let memberTsType: ts.Type | undefined;
      if (ts.isInterfaceDeclaration(stmt)) {
        for (const member of stmt.members) {
          if (ts.isPropertySignature(member) && member.name) {
            const memberName = (member.name as ts.Identifier).text;
            if (memberName === field.name) {
              memberTsType = ctx.checker.getTypeAtLocation(member);
              break;
            }
          }
        }
      } else {
        const aliasType = ctx.checker.getTypeAtLocation(stmt);
        const props = aliasType.getProperties();
        for (const prop of props) {
          if (prop.name === field.name) {
            memberTsType = ctx.checker.getTypeOfSymbol(prop);
            break;
          }
        }
      }

      if (!memberTsType) continue;
      const resolved = resolveWasmType(ctx, memberTsType);
      if (resolved.kind === "ref" || resolved.kind === "ref_null") {
        field.type = resolved;
        changed = true;
      }
    }

    // If any fields changed, update the type definition in mod.types too
    if (changed) {
      const typeDef = ctx.mod.types[structTypeIdx];
      if (typeDef && typeDef.kind === "struct") {
        (typeDef as any).fields = fields;
      }
    }
  }
}

export function collectObjectType(ctx: CodegenContext, name: string, type: ts.Type): void {
  const fields: FieldDef[] = [];
  for (const prop of type.getProperties()) {
    const propType = ctx.checker.getTypeOfSymbol(prop);
    const wasmType = mapTsTypeToWasm(propType, ctx.checker);
    fields.push({
      name: prop.name,
      type: wasmType,
      mutable: true,
    });
  }

  if (fields.length > 0) {
    const typeIdx = ctx.mod.types.length;
    ctx.mod.types.push({
      kind: "struct",
      name,
      fields,
    } as StructTypeDef);
    ctx.structMap.set(name, typeIdx);
    ctx.typeIdxToStructName.set(typeIdx, name);
    ctx.structFields.set(name, fields);
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
