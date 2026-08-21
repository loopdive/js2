// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Single-pass AST import/feature collector (#592). The `UnifiedCollectorState`
 * subsystem: state shape, factory, per-node visitor, and the finalizer that
 * materializes host imports. Extracted verbatim from codegen/declarations.ts (#3268).
 */
import {
  isBigIntType,
  isBooleanType,
  isHeterogeneousUnion,
  isNumberType,
  isNumberWrapperType,
  isStringType,
} from "../../checker/type-mapper.js";
import { forEachChild, ts } from "../../ts-api.js";
import { exactIndirectEvalStatement } from "../../eval-call-shape.js";
import { ensureWrapperTypes } from "../any-helpers.js";
import { ASYNC_CPS_ENABLED, analyzeAsyncBody, asyncFnNeedsCps } from "../async-cps.js";
import { asyncFnNeedsHostDrive, asyncGenDrivableUnderCarrier, asyncGenStem } from "../async-frame.js";
import { isStandalonePromiseActive } from "../async-scheduler.js";
import { unwrapTransparentExpression } from "../object-descriptor-analysis.js";
import {
  functionBodyReferencesThis,
  genBodyReferencesSuper,
  genBodyReferencesThis,
  methodBodyRefsShadowedOuterLocal,
} from "../closures.js";
import { hasStaticModifier } from "../ast-modifiers.js"; // (#3132 S2) method-drive pre-pass gates
import { bodyNeedsArgumentsObject } from "../helpers/body-uses-arguments.js";
import { emitNativeEscape, emitNativeUnescape } from "../escape-native.js";
import { isNativeGeneratorCandidate, sourceNeedsGeneratorHostImports } from "../generators-native.js";
import {
  FUNCTIONAL_ARRAY_METHODS,
  KNOWN_CONSTRUCTORS,
  MATH_HOST_METHODS_1ARG,
  MATH_HOST_METHODS_2ARG,
  STRING_METHODS,
  addArrayIteratorImports,
  addForInImports,
  addGeneratorImports,
  addIteratorImports,
  addStringImports,
  addUnionImports,
  hasAsyncModifier,
  hasDeclareModifier,
  parseRegExpLiteral,
} from "../index.js";
import { isPlainNamedMethodDeclaration, objectLiteralSpreadTakesHostPath } from "../literals.js";
import { ensureNativeStringHelpers } from "../native-strings.js";
import { emitNativeNumberFormat, usesNativeNumberFormat } from "../number-format-native.js";
import { emitNativeBigIntFormat } from "../bigint-format-native.js";
import { emitNativeParseNumber } from "../parse-number-native.js";
import { resolveGlobalParseBuiltin } from "../global-builtin-resolution.js";
import { emitWasiErrorConstructor, isWasiErrorName } from "../registry/error-types.js";
import { addImport, addStringConstantGlobal } from "../registry/imports.js";
import { addFuncType, getOrRegisterTemplateVecType } from "../registry/types.js";
import { emitNativeUriDecode, emitNativeUriEncode } from "../uri-encoding-native.js";
import type { ValType } from "../../ir/types.js";
import type { CodegenContext } from "../context/types.js";

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
  // #1164 — the exact `(0, eval)(string);` statement owned by the IR host
  // import slice. This is collected before body planning because an IR body
  // bypasses the legacy emitter that otherwise registers __extern_eval.
  hostIndirectEvalNeeded: boolean;
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
  // (#3132 PR-2) sanitized stems of async gens judged drivable so far — a
  // repeat stem is a collision (second gen falls to legacy), so it flips the
  // module to non-drivable (carrier off). See widenAsyncGenFallback.
  asyncGenDrivableStems: Set<string>;
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
 * (#3912) The pure-Wasm §7.1.4.1 StringToNumber helper.
 *
 * It shares `state.parseNeeded` with the real JS globals `parseInt` /
 * `parseFloat`, but unlike those it is NOT a host function — `src/runtime.ts`
 * has no `env.__str_to_number` to bind. It must therefore always be EMITTED,
 * never imported; see the `collectParseImports` finalize block. Named once here
 * so the producing sites and that consuming check cannot drift apart.
 */
const STR_TO_NUMBER_HELPER = "__str_to_number";

// (#2903) Method names whose CALL can mint a HOST promise in a standalone
// module even while the native `$Promise` chain is active — the host-routed
// combinators/instance methods (`__array_from_async` etc. imports). Matched on
// ANY receiver (conservative: a false positive only preserves the pre-#2903
// host fallback arm). Plain `Promise.all`/`race`/(#3137) `allSettled`/`any`
// are NOT listed — those lower to the host-free native combinators
// (#2919/#2867 Gap 4/#3137); `.finally` is NOT listed since it lowers to the
// native §27.2.5.3 machinery on Promise/any receivers under the active lane
// (#2903 sub-front — this un-flags every `.finally`-using module for the
// then-bridge de-leak); only the subclass-receiver combinator form is flagged
// (inline check at the scan site — exotic shapes that fall to the host path
// lazily register their `Promise_*` import, which the bridge's funcMap
// producer check catches).
const HOST_PROMISE_SOURCE_METHOD_NAMES = new Set(["allKeyed", "allSettledKeyed", "fromAsync"]);

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
    hostIndirectEvalNeeded: false,
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
    asyncGenDrivableStems: new Set(),
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

function collectorSeesAmbientEval(ctx: CodegenContext, identifier: ts.Identifier): boolean {
  const declarations = ctx.oracle.declarationsOf(identifier);
  // Match `makeIrAmbientBindingPredicate`: a merged lib symbol may carry
  // several declarations, and the selector/lowerer accept it when one is an
  // ambient declaration. A source-owned shadow has no declaration-file arm.
  return declarations.some((declaration) => declaration.getSourceFile().isDeclarationFile);
}

function collectorHostStringFact(ctx: CodegenContext, expression: ts.Expression): boolean {
  const fact = ctx.oracle.typeFactOf(expression);
  return (
    fact.kind === "string" ||
    (fact.kind === "union" &&
      !fact.nullable &&
      !fact.undefinable &&
      fact.parts.length > 0 &&
      fact.parts.every((part) => part.kind === "string"))
  );
}

function stripHostEvalTypeAssertions(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/**
 * Match the selector's proven-string discipline closely enough that the
 * collector cannot omit an import from a claimed IR body. In particular,
 * diagnostics-off annotations do not make `const s: string = 1` look like a
 * host string merely because its declared type says so.
 */
function collectorProvesHostEvalString(
  ctx: CodegenContext,
  expression: ts.Expression,
  seen = new Set<ts.VariableDeclaration>(),
): boolean {
  const candidate = stripHostEvalTypeAssertions(expression);
  if (ts.isStringLiteral(candidate) || ts.isNoSubstitutionTemplateLiteral(candidate)) return true;
  if (!collectorHostStringFact(ctx, candidate)) return false;
  if (!ts.isIdentifier(candidate)) return true;
  const declaration = ctx.oracle.variableDeclarationOf(candidate);
  if (!declaration) return true; // typed parameter / non-local checker binding
  if (!declaration.initializer || seen.has(declaration)) return false;
  const nextSeen = new Set(seen);
  nextSeen.add(declaration);
  return collectorProvesHostEvalString(ctx, declaration.initializer, nextSeen);
}

function needsHostIndirectEvalImport(ctx: CodegenContext, node: ts.Node): boolean {
  if (ctx.standalone || ctx.wasi || ctx.strictNoHostImports || ctx.nativeStrings || !ts.isCallExpression(node)) {
    return false;
  }
  const shape = exactIndirectEvalStatement(node);
  return (
    !!shape && collectorSeesAmbientEval(ctx, shape.evalIdentifier) && collectorProvesHostEvalString(ctx, shape.source)
  );
}

/**
 * (#4454) True when this object literal will install a PLAIN-NAMED method
 * shorthand (`m() {}`, `"m"() {}`, `0() {}`) through the
 * `this`-forwarding `env::__make_getter_callback` bridge, so the collector must
 * pre-register that import.
 *
 * A SPREAD-bearing literal with no concrete contextual type is diverted to the
 * host plain-object path by `objectLiteralSpreadTakesHostPath` (#2804), whose
 * MethodDeclaration arm materializes each method as a real runtime own property
 * via `emitObjectLiteralMethodFn` → `compileArrowAsCallback({needsThis:true})` →
 * the bridge. The collector previously registered it only for get/set accessors
 * (#1239) and computed method keys (#1433/#3048), so `{ ...src, m() {…} }`
 * reached the emit site with an empty `funcMap` and hard-CE'd with
 * "Missing __make_getter_callback import" — found by the #4420 self-hosting
 * sweep, where `src/ts-api.ts` synthesizes its TS7 shim as
 * `{ ...astMod, ...isMod, createProgram() {…}, … }` typed `Record<string, unknown>`.
 *
 * Gating on the EMITTER'S OWN predicate rather than on "has a spread" keeps
 * pre-pass and emit site in lockstep — the discipline that avoids re-introducing
 * the late-import index-shift hazard (#1384) — and leaves a concretely-annotated
 * target (`const o: { a: number; m(): number } = { ...s, m() {…} }`) on the
 * struct path with no unused import.
 *
 * Host/GC only, mirroring `emitObjectLiteralMethodFn`'s own branch: standalone /
 * native-first lowers the method to a host-free closure (#2194) and must not
 * declare the unsatisfiable `env::` import.
 */
function objectLiteralMethodNeedsGetterBridge(ctx: CodegenContext, node: ts.Node): boolean {
  if (!ts.isObjectLiteralExpression(node)) return false;
  if (ctx.standalone || ctx.targetProfile.semanticProviders === "native-first") return false;
  if (!node.properties.some((p) => ts.isSpreadAssignment(p))) return false;
  if (!node.properties.some((p) => isPlainNamedMethodDeclaration(p))) return false;
  return objectLiteralSpreadTakesHostPath(ctx, node);
}

/** Single-pass visitor called on every AST node */
export function unifiedVisitNode(ctx: CodegenContext, state: UnifiedCollectorState, node: ts.Node): void {
  // #1164 — `__extern_eval` is an IR-owned host capability only for the exact
  // certified statement shape. Do not arm it for direct eval, a discarded
  // non-string, a shadowed callee, or a value-producing call that stays legacy.
  if (needsHostIndirectEvalImport(ctx, node)) state.hostIndirectEvalNeeded = true;

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
        } else if (elemType && (elemType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) {
          // (#3579) `any`/`unknown` element → boxed externref. The default sort
          // ToStrings each element via the runtime `__extern_toString` then
          // compares with `string_compare` (§23.1.3.30). Pre-register the compare
          // import here so `compileArrayDefaultToStringSort` finds it (else it
          // returns null and the sort silently no-ops — `[10,9,1].sort()` on an
          // untyped array stayed unordered). HOST lane only; native/standalone
          // keeps its externref-bail no-op (a pre-existing gap, unchanged here).
          state.primitiveNeeded.add("string_compare");
        } else if (elemType && elemType.isUnion()) {
          // (#3579) A mixed union element (e.g. `(number|string|undefined)[]`,
          // the `[-1, obj, 1, "X", …]` shape) also boxes to externref on the host
          // lane → same ToString+compare path. `string_compare` is only actually
          // imported when `!ctx.nativeStrings` (see the addImport gate below), and
          // `compileArrayDefaultToStringSort` gates on the real `externref` ValType,
          // so a union that lowers to a ref (unreached today) simply no-ops —
          // registering the import is inert in every other lane.
          state.primitiveNeeded.add("string_compare");
        }
      }
    }
    if (isNumberType(receiverType) && methodName === "toString") {
      // #1321: toString(radix) needs a 2-arg host import so the radix is
      // actually used. The 1-arg `number_toString` only handles default base 10.
      if (node.arguments.length > 0) {
        state.primitiveNeeded.add("number_toString_radix");
        // (#3175) An `undefined` radix (§21.1.3.6 step 2) routes back to the
        // 1-arg base-10 `number_toString` at the call site, so register it too
        // — otherwise `(5).toString(undefined)` finds no emitted helper and the
        // call site returns a null string ref.
        state.primitiveNeeded.add("number_toString");
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
  // String(expr) and new String(expr) need number_toString for ToString.
  if (
    (ts.isCallExpression(node) || ts.isNewExpression(node)) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "String" &&
    (node.arguments?.length ?? 0) >= 1
  ) {
    if (ctx.oracle.typeFactOf(node.arguments![0]!).kind !== "string") {
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
    const globalParseBuiltin = resolveGlobalParseBuiltin(node.expression, ctx.oracle);
    const name = globalParseBuiltin ?? node.expression.text;
    if (globalParseBuiltin !== undefined) {
      state.parseNeeded.add(globalParseBuiltin);
      // (#2652) In standalone / WASI the native parse helpers take a string ref;
      // a NON-string primitive arg (`parseInt(true)` / `parseInt(-1)`) must be
      // run through ToString at the call site (emitToString) BEFORE the call.
      // Pre-register the helpers/literals that lowering needs so no late
      // module-function shift is forced mid-body:
      //   numeric arg  → `number_toString`
      //   boolean arg  → "true"/"false" string literals (emitBoolToString)
      //   void arg     → "undefined" literal
      if (
        (ctx.targetProfile.semanticProviders === "native-first" || ctx.standalone || ctx.wasi) &&
        node.arguments.length >= 1
      ) {
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
      if (ctx.nativeStrings) state.parseNeeded.add(STR_TO_NUMBER_HELPER);
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
      state.parseNeeded.add(ctx.nativeStrings ? STR_TO_NUMBER_HELPER : "parseFloat");
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
          state.parseNeeded.add(ctx.nativeStrings ? STR_TO_NUMBER_HELPER : "parseFloat");
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
    !isStandalonePromiseActive(ctx) &&
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
    //
    // (#2967) Post-flip both predicates can be true for the same fn (host-drive
    // claims the CPS shapes on declarations AND — since slice 2a — on lifted
    // closures; only the shapes host-drive declines, e.g. concise arrow bodies
    // and the pattern-param carve-out, still emit CPS). Registering both sets
    // is the safe superset (the CPS trio is a subset of the host-drive six);
    // the hazard-free direction — every emit path's imports pre-registered —
    // holds for every routing outcome.
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
    if (!state.getterCallbackFound && objectLiteralMethodNeedsGetterBridge(ctx, node)) {
      state.getterCallbackFound = true;
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
    (node as ts.Node & { asteriskToken?: ts.Node }).asteriskToken !== undefined &&
    (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isMethodDeclaration(node)) &&
    node.body !== undefined &&
    hasAsyncModifier(node)
  ) {
    ctx.moduleHasAsyncGen = true;
    // (#3132 PR-2) Decide, conservatively and pre-body, whether THIS async gen
    // will drive-lower host-free under the native `$Promise` carrier. If ANY
    // async gen in the module will NOT (a method — not wired to the drive; a
    // body outside the bounded drive shape; a rest param / unsafe spill; a
    // stem collision), the module keeps a legacy `__gen_*` buffer, so the
    // carrier must stay OFF (widenAsyncGenFallback) to avoid the #2980
    // native-`$Promise`-into-host-buffer mix. Only a module whose async gens
    // are ALL drivable keeps the carrier ON. `asyncGenDrivableUnderCarrier`
    // is the SAME shape `isAsyncGenDriveCandidate` admits under the carrier, so
    // the pre-pass verdict matches the emit-time decision; the stem-dedup here
    // mirrors emit's stem-collision guard.
    if (!ctx.moduleHasNonDrivableAsyncGen) {
      let drivable: boolean;
      // (#3132 S2) Async-gen METHODS are now wired to the drive (class bodies
      // — class-bodies.ts; object-literal methods — literals.ts), so a method
      // is drivable under the SAME preconditions those emit sites apply in
      // front of `isAsyncGenDriveCandidate`: no `super` (home-object binding
      // not threaded into the resume fn), no `arguments` (entry-fn vec
      // struct), and no STATIC body reading `this` (static `this` resolves
      // via the class-object-global fallback the resume FunctionContext does
      // not carry). An INSTANCE (or object-literal) `this`-reading body IS
      // drivable — the receiver rides as frame param field 0 and restores by
      // name. Any method the emit paths SKIP entirely (dynamic computed name,
      // duplicate-name dedup) emits NO legacy buffer, so judging it drivable
      // here is still mix-safe (the hazard is only a legacy `__gen_*` buffer
      // coexisting with the native carrier).
      const methodExclusion =
        ts.isMethodDeclaration(node) &&
        (genBodyReferencesSuper(node.body) ||
          bodyNeedsArgumentsObject(node.body) ||
          (hasStaticModifier(node) && genBodyReferencesThis(node.body)) ||
          // Shadowed-outer-local shape: the capture promotion mis-binds the
          // method body vs sibling closures (pre-existing bug) — keep the
          // module on the host Promise pipeline so `.then` callbacks are not
          // newly exposed to the divergence (see methodBodyRefsShadowedOuterLocal).
          methodBodyRefsShadowedOuterLocal(node));
      if (methodExclusion) {
        drivable = false;
      } else if (asyncGenDrivableUnderCarrier(ctx, node)) {
        const stem = asyncGenStem(node);
        if (state.asyncGenDrivableStems.has(stem)) {
          drivable = false; // stem collision → second gen falls to legacy
        } else {
          state.asyncGenDrivableStems.add(stem);
          drivable = true;
        }
      } else {
        drivable = false;
      }
      if (!drivable) ctx.moduleHasNonDrivableAsyncGen = true;
    }
  }

  // (#2903) Flag any construct that can mint a HOST promise in a standalone
  // module while the native `$Promise` chain is active: dynamic `import()`,
  // host-routed combinators (`allKeyed`/`allSettledKeyed`; subclass-receiver
  // `all`/`race`/`allSettled`/`any`), `Array.fromAsync`, and (below, separate
  // block) `class X extends Promise`. The `.then`/`.catch` receiver bridge keys
  // its miss arm on this (see `moduleHasHostPromiseSource` in
  // context/types.ts): no producer in the module ⇒ the host fallback arm is
  // provably dead ⇒ it is replaced by a native TypeError, dropping the
  // `Promise_then*`/`__make_callback` leak. Conservative by design — a false
  // positive merely keeps the pre-#2903 host arm (module stays leaky, exactly
  // as before); only a false NEGATIVE could change behaviour, so names match
  // on ANY receiver where the lowering can be host-routed. Pre-body (same
  // discipline as `moduleHasAsyncGen` above) so a textually-later producer is
  // seen before any `.then` bridge compiles. gc/host + wasi are untouched
  // (standalone-only setter; the consumer re-checks the target too).
  if (
    ctx.standalone === true &&
    ctx.wasi !== true &&
    ctx.moduleHasHostPromiseSource !== true &&
    ts.isCallExpression(node)
  ) {
    if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      ctx.moduleHasHostPromiseSource = true;
    } else {
      let calleeName: string | undefined;
      let recvIsPromiseIdent = false;
      if (ts.isPropertyAccessExpression(node.expression)) {
        calleeName = node.expression.name.text;
        recvIsPromiseIdent =
          ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "Promise";
      } else if (
        ts.isElementAccessExpression(node.expression) &&
        ts.isStringLiteralLike(node.expression.argumentExpression)
      ) {
        calleeName = node.expression.argumentExpression.text;
      }
      if (
        calleeName !== undefined &&
        (HOST_PROMISE_SOURCE_METHOD_NAMES.has(calleeName) ||
          // (#3137) native-combinator names: only the subclass-receiver form
          // (`MyP.all(...)`) is host-routed; plain `Promise.<m>(...)` is native.
          ((calleeName === "all" || calleeName === "race" || calleeName === "allSettled" || calleeName === "any") &&
            !recvIsPromiseIdent))
      ) {
        ctx.moduleHasHostPromiseSource = true;
      }
    }
  }

  // (#2903 finally sub-front) A `class X extends Promise` in the module is a
  // host-promise producer in its own right: subclass construction and the
  // inherited statics (`X.resolve()`/`X.reject()`) route through host imports
  // (`__new_Promise` + the symbol-derived static-method import), so their
  // results are HOST promises that a native then/finally bridge miss arm must
  // keep the host fallback for. This was previously masked for the
  // subclass-`finally` tests by the (now-removed) `.finally` syntactic flag —
  // the subclass shape needs its own flag, keyed on the heritage clause
  // (pre-body, so a textually-later class declaration is still seen).
  if (
    ctx.standalone === true &&
    ctx.wasi !== true &&
    ctx.moduleHasHostPromiseSource !== true &&
    (ts.isClassDeclaration(node) || ts.isClassExpression(node))
  ) {
    for (const clause of node.heritageClauses ?? []) {
      if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue;
      for (const typeRef of clause.types) {
        if (ts.isIdentifier(typeRef.expression) && typeRef.expression.text === "Promise") {
          ctx.moduleHasHostPromiseSource = true;
        }
      }
    }
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
  // #1164 — reserve the host eval import before IR bodies are planned. The
  // existing legacy scan may already have supplied the identical funcMap slot;
  // preserve it rather than perturbing the function index space a second time.
  if (state.hostIndirectEvalNeeded && ctx.funcMap.get("__extern_eval") === undefined) {
    const typeIdx = addFuncType(ctx, [{ kind: "externref" }, { kind: "i32" }], [{ kind: "externref" }]);
    addImport(ctx, "env", "__extern_eval", { kind: "func", typeIdx });
  }

  // ── collectConsoleImports finalize ──
  // In WASI mode, console.log/error use fd_write — skip JS host console imports.
  // (#3436) In standalone mode there is no JS host either, so emitting the
  // `env.console_*` imports leaks an unsatisfiable import that makes every
  // standalone module (notably every test262 file, whose universal prelude's
  // `print` shim calls `console.log`) fail to instantiate. The standalone call
  // site (builtins.ts `compileConsoleCall`) lowers `console.*` to a native
  // no-op sink (arguments evaluated for side effects, then dropped) — test262
  // verdicts come from thrown exceptions, not printed output — so no console
  // host import is needed here.
  // (#3469) Standalone has no host console import AND no `fd_write` sink, so
  // `console.*`/`print` lowered to a pure no-op (#3436) — the test262 async
  // completion marker (`$DONE → print → console.log("Test262:AsyncTestComplete")`)
  // went nowhere and every host-free async test timed out unobserved. When the
  // source uses `console.*` in standalone mode, flag it so the pre-body phase
  // mints the in-module GC string sink (`__stdout_acc` + `__stdout_append`) and
  // finalize emits the `__stdout_prepare`/`__stdout_char` readout exports. The
  // sink stays 100% host-free (WasmGC in-module), so the #2961 import-leak gate
  // still rejects genuine host imports.
  if (ctx.standalone && state.consoleNeededByMethod.size > 0) {
    ctx.usesStandaloneConsoleSink = true;
  }

  if (!ctx.wasi && !ctx.standalone) {
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
  const nativeNumberFormat = usesNativeNumberFormat(ctx);
  // #1759/#3912: wherever strings are natively represented, template
  // interpolation and String(number) need the pure-Wasm Number::toString, NOT
  // env.number_toString — the host import hands back a real JS string, which
  // every native consumer then mis-reads as an `$AnyString` box. All three
  // gates below read that ONE predicate, so they cannot re-diverge.
  const needsNativeNumberToString = state.primitiveNeeded.has("number_toString") && nativeNumberFormat;
  if (state.primitiveNeeded.has("number_toString") && !needsNativeNumberToString) {
    const t = addFuncType(ctx, [{ kind: "f64" }], [{ kind: "externref" }]);
    addImport(ctx, "env", "number_toString", { kind: "func", typeIdx: t });
  }
  // #1321: 2-arg `number_toString_radix(value, radix)` for `toString(radix)` calls.
  // Without this, the codegen validates the radix range but then calls 1-arg
  // `number_toString(value)`, silently producing decimal output for any radix.
  // #1335 Phase 1: standalone/WASI emits the safe-integer radix formatter in
  // pure Wasm instead of requesting the JS host import.
  const needsNativeNumberToStringRadix = state.primitiveNeeded.has("number_toString_radix") && nativeNumberFormat;
  if (state.primitiveNeeded.has("number_toString_radix") && !needsNativeNumberToStringRadix) {
    const t = addFuncType(ctx, [{ kind: "f64" }, { kind: "f64" }], [{ kind: "externref" }]);
    addImport(ctx, "env", "number_toString_radix", { kind: "func", typeIdx: t });
  }
  // (#1644 Slice D) BigInt#toString — i64 receiver, optional i32 radix.
  if (state.primitiveNeeded.has("bigint_toString") && !nativeNumberFormat) {
    const t = addFuncType(ctx, [{ kind: "i64" }], [{ kind: "externref" }]);
    addImport(ctx, "env", "bigint_toString", { kind: "func", typeIdx: t });
  }
  if (state.primitiveNeeded.has("bigint_toString_radix") && !nativeNumberFormat) {
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
  if (nativeNumberFormat) {
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
    const bigintNative = new Set<string>();
    for (const name of ["bigint_toString", "bigint_toString_radix"]) {
      if (state.primitiveNeeded.has(name)) bigintNative.add(name);
    }
    if (bigintNative.size > 0) emitNativeBigIntFormat(ctx, bigintNative);
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
      if (
        ctx.targetProfile.semanticProviders === "native-first" &&
        (method === "match" || method === "matchAll" || method === "search")
      ) {
        continue;
      }
      if (ctx.targetProfile.semanticProviders === "native-first" && state.stringRegexpMethodNeeded.has(method)) {
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
      if (ctx.ambientBuiltinFuncMap.has(name)) continue;
      // (#3912) The StringToNumber helper is PURE WASM, not a JS global — the
      // host runtime has no binding for it, so requesting it as an import
      // yielded a stub whose result read back as NaN. It only ever enters
      // `parseNeeded` under `ctx.nativeStrings` (see its three producing sites
      // above), and `fast` is the config that sets `nativeStrings` without
      // `wasi` / `standalone` — so it fell through the target-only gate here
      // and `Number("42")` returned NaN across the whole gc-native lane. Always
      // emit it natively; `parseInt` / `parseFloat` keep their host imports
      // off-target, and those are real JS globals the host DOES provide.
      if (
        ctx.targetProfile.semanticProviders === "native-first" ||
        ctx.wasi ||
        ctx.standalone ||
        name === STR_TO_NUMBER_HELPER
      ) {
        parseNative.add(name);
        continue;
      }
      const shadowed = ctx.funcMap.get(name);
      if (name === "parseInt") {
        const typeIdx = addFuncType(ctx, [{ kind: "externref" }, { kind: "f64" }], [{ kind: "f64" }]);
        addImport(ctx, "env", name, { kind: "func", typeIdx });
      } else {
        const typeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "f64" }]);
        addImport(ctx, "env", name, { kind: "func", typeIdx });
      }
      const builtinIdx = ctx.funcMap.get(name);
      if (builtinIdx !== undefined) ctx.ambientBuiltinFuncMap.set(name, builtinIdx);
      if (shadowed !== undefined) ctx.funcMap.set(name, shadowed);
    }
    if (parseNative.size > 0) {
      const shadowed = new Map<string, number>();
      for (const name of parseNative) {
        const existing = ctx.funcMap.get(name);
        if (existing !== undefined) {
          shadowed.set(name, existing);
          ctx.funcMap.delete(name);
        }
      }
      emitNativeParseNumber(ctx, parseNative);
      for (const name of parseNative) {
        const builtinIdx = ctx.funcMap.get(name);
        if (builtinIdx !== undefined) ctx.ambientBuiltinFuncMap.set(name, builtinIdx);
        const previous = shadowed.get(name);
        if (previous !== undefined) ctx.funcMap.set(name, previous);
      }
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
      if (ctx.targetProfile.semanticProviders === "native-first" || ctx.wasi || ctx.standalone) {
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
    if (ctx.targetProfile.semanticProviders === "native-first" || ctx.standalone || ctx.wasi) {
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
    if (isStandalonePromiseActive(ctx) && (method === "resolve" || method === "reject")) continue;
    // (#2867 Gap 4) Under the native-`$Promise` carrier, `Promise.all`/`Promise.race`
    // over an array literal lower to the host-free native combinator (no host
    // import). Skip the unsatisfiable `Promise_all`/`Promise_race` pre-registration
    // here; the host path (generic iterables / subclass receivers) still
    // lazily `ensureLateImport`s it at the call site when actually needed.
    // (#3137) `allSettled`/`any` are native on the same machinery now — same skip.
    if (
      isStandalonePromiseActive(ctx) &&
      (method === "all" || method === "race" || method === "allSettled" || method === "any")
    )
      continue;
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
  if (state.promiseNeedConstructor && !isStandalonePromiseActive(ctx) && !ctx.funcMap.has("Promise_new")) {
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
  const jsonUsesNativeProvider = ctx.targetProfile.semanticProviders === "native-first";
  if (!jsonUsesNativeProvider && (state.jsonNeedStringify || state.jsonNeedParse)) {
    addUnionImports(ctx);
  }
  if (!jsonUsesNativeProvider && state.jsonNeedStringify) {
    // (value: externref, replacer: externref, space: externref) -> externref
    const typeIdx = addFuncType(
      ctx,
      [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
      [{ kind: "externref" }],
    );
    addImport(ctx, "env", "JSON_stringify", { kind: "func", typeIdx });
  }
  if (!jsonUsesNativeProvider && state.jsonNeedParse) {
    // #2013 — (text, reviver) so JSON.parse can apply §25.5.1
    // InternalizeJSONProperty. The reviver is `ref.null.extern` when absent.
    const typeIdx = addFuncType(ctx, [{ kind: "externref" }, { kind: "externref" }], [{ kind: "externref" }]);
    addImport(ctx, "env", "JSON_parse", { kind: "func", typeIdx });
  }

  // ── collectCallbackImports finalize ──
  if (state.callbackFound || state.getterCallbackFound || state.asyncCpsFound) {
    const typeIdx = addFuncType(ctx, [{ kind: "i32" }, { kind: "externref" }], [{ kind: "externref" }]);
    // (#3235) `callbackFound` fires for ANY arrow/function-expr — coarse. In
    // JS-host mode the upfront registration gives `__make_callback` a stable
    // funcIdx (#1384). But standalone/WASI has NO host: a `call __make_callback`
    // can never succeed, so no passing standalone module actually calls it (#3098's
    // native `__apply_closure`/`__hof_*`/`__iter_hof_*` serve exercised callbacks
    // host-free) — the eager registration only ever *declares* an unsatisfiable
    // never-called import that fails the host-free metric. Gate it off (mirrors the
    // async-CPS `!ctx.standalone` gate below); any residual host-callback site
    // degrades to the native closure struct (see compileArrowAsCallback). JS-host
    // lane byte-identical.
    if (
      !isStandalonePromiseActive(ctx) &&
      (state.callbackFound || state.asyncCpsFound) &&
      !ctx.funcMap.has("__make_callback")
    ) {
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
  if (!isStandalonePromiseActive(ctx) && (state.asyncCpsFound || state.asyncHostDriveFound)) {
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
  if (!isStandalonePromiseActive(ctx) && state.asyncHostDriveFound) {
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
  if (state.forInFound && ctx.targetProfile.semanticProviders !== "native-first" && !ctx.standalone && !ctx.wasi) {
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
    if (ctx.targetProfile.semanticProviders === "native-first" && isWasiErrorName(name)) {
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

/** Returns true if an Object.defineProperty descriptor ObjectLiteral is an accessor descriptor
 * with an ACTUAL function getter or setter that needs the sidecar/extern path.
 * Descriptors with `get: undefined` or `set: undefined` are NOT treated as accessor descriptors —
 * they are widened like data descriptors so the property appears in for-in and hasOwnProperty
 * (matching baseline behavior where all Object.defineProperty targets are widened). (#929) */
function isAccessorDescriptor(descArg: ts.Expression): boolean {
  descArg = unwrapTransparentExpression(descArg);
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
