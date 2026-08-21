// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Closure and arrow-function compilation for js2wasm.
 *
 * Extracted from expressions.ts (issue #688, step 4).
 *
 * Functions in this file:
 *   - collectReferencedIdentifiers, collectWrittenIdentifiers
 *   - promoteAccessorCapturesToGlobals
 *   - collectBindingPatternNames, isOwnParamName
 *   - emitArrowParamDestructuring, emitArrowParamDefaults, emitMethodParamDefaults
 *   - isHostCallbackArgument
 *   - compileArrowFunction, compileArrowAsClosure, compileArrowAsCallback
 *   - getFuncSignature, getOrCreateFuncRefWrapperTypes, emitFuncRefAsClosure
 */

import { ts, forEachChild } from "../ts-api.js";
import { isVoidType, unwrapPromiseType, isPromiseType } from "../checker/type-mapper.js";
import type { FieldDef, Instr, LocalDef, StructTypeDef, ValType } from "../ir/types.js";
import { isStandalonePromiseActive } from "./async-scheduler.js"; // (#2867 Gap 1) native-$Promise carrier gate
import { definedFuncAt, funcSignatureOf, mintDefinedFunc, pushDefinedFunc } from "./func-space.js"; // (#1916 S2 read chokepoint / S3b stable-regime minting)
import { pushProgramAbiNestedCallable, pushProgramAbiTypedThisTwin } from "./program-abi-source-callable-planning.js";
import { inLiveShiftRange } from "../emit/resolve-layout.js"; // (#1916 S3b) manual import-shift must skip stable handles
import { addStringConstantGlobal } from "./registry/imports.js"; // (#2025)
import { stringConstantExternrefInstrs } from "./native-strings.js"; // (#2025)
import { noJsHost } from "./expressions/helpers.js"; // (#2025)
import { emitWasiErrorConstructor } from "./registry/error-types.js"; // (#2025)
import { widenClosureReturnForPreInitVar } from "./declarations/hoisted-var-preinit-read.js"; // (#4206)
import { popBody, pushBody } from "./context/bodies.js";
import { recordClosureBody } from "./context/body-route-audit.js";
import { reportError } from "./context/errors.js";
import { reportSilentFallback } from "./fallback-telemetry.js";
import { resolveLiftedMethodThisStruct } from "./fnctor-escape-gate.js"; // (#2681/#2686 A3) lifted-method `this`→struct
import { allocLocal, allocTempLocal, getLocalType } from "./context/locals.js";
import { seedLiftedClosureArgumentsCallee } from "./arguments-callee.js"; // (#4243) §10.6 step 13.a
import { resolveCallbackMakerName } from "./callback-ctor-bridge.js"; // (#4394) bridge [[Construct]] parity
import { registerStandaloneDomCallbackDirectClosure } from "./standalone-dom-callback-authority.js";
import type { ClosureInfo, CodegenContext, FunctionContext } from "./context/types.js";
import {
  addFuncType,
  destructureParamObject,
  addGeneratorImports,
  ensureExnTag,
  ensureStructForType,
  getArrTypeIdxFromVec,
  getOrRegisterRefCellType,
  getOrRegisterVecType,
  hoistVarDeclarations,
  isTupleType,
  nextModuleGlobalIdx,
  resolveWasmType,
  resolveWasmTypeForClosureReturn,
} from "./index.js";
import { refCellValueType } from "./registry/types.js"; // (#3328) boxed-capture valType fallback
import { buildTargetTaggedTry } from "../ir/try-table.js";
import {
  coerceType,
  compileExpression,
  emitBoundsCheckedArrayGet,
  ensureLateImport as ensureLateImportShared,
  flushLateImportShifts as flushLateImportShiftsShared,
  getCol,
  getLine,
  registerCompileArrowAsClosure,
  resolveEnclosingClassName,
  valTypesMatch,
} from "./shared.js";
import {
  collectInstrs,
  compileExternrefArrayDestructuringDecl,
  compileExternrefObjectDestructuringDecl,
  compileStatement,
  hoistFunctionDeclarations,
} from "./statements.js";
import { coercionInstrs, emitGuardedRefCast } from "./type-coercion.js";
import {
  buildDestructureNullThrow,
  isNullOrUndefinedLiteral,
  structHintForBindingPattern,
} from "./destructuring-params.js";
import { compileObjectLiteralAsExternref } from "./literals.js";
import {
  cacheParamDefaultArgc,
  emitF64ParamSentinelCheck,
  emitArgumentsVecBody,
  emitParamDefaultArgMissingCheck,
  ensureCurrentThisGlobal,
  paramDefaultNeedsArgc,
} from "./statements/nested-declarations.js";
import { detectStringBuilders, type StringBuilderPresizeInfo } from "./string-builder.js";
// (#3683 S2) typed-`this` twin admission + prologue/shim emission.
import {
  admitTypedThisTwin,
  buildTypedThisForwardGuard,
  directCallLoweringEnabled,
  emitTypedThisPrologue,
  recordDirectCallGeneric,
  recordDirectCallTwin,
  refinedTwinReturnType,
} from "./typed-this.js";
import { addFunctionOwnLocals } from "../ir/analysis/binding-info.js"; // (#2103) shared, memoized per-function binding-info oracle
// (#4601 route 1) The pure-AST scope / free-variable walks now live BELOW the
// IR so `statements/loop-analysis.ts` — which five `src/ir/` modules import —
// can follow them down. Re-exported below so every existing consumer of
// `closures.js` keeps importing exactly what it imported before.
import {
  collectBindingPatternNames,
  collectFunctionOwnLocals,
  collectReferencedIdentifiers,
  isFunctionScopeBoundary,
} from "../ir/analysis/ast-scope.js";
export {
  collectBindingPatternNames,
  collectFunctionOwnLocals,
  collectReferencedIdentifiers,
} from "../ir/analysis/ast-scope.js";
// (#2957 phase 2) arrow/fn-expr async activation. Imported LAST: `async-activation`
// pulls the `async-cps`/`async-frame` chain which imports back into `closures`
// (a cycle), so it must evaluate after this module's other deps are loaded to
// avoid perturbing the init order of the coercion-engine/string-ops chain.
import {
  planAsyncClosureActivation,
  emitAsyncClosureBody,
  reportDeclinedAsyncRejectionHazard,
} from "./async-activation.js";
import { emitAsyncGenerator, isAsyncGenDriveCandidate } from "./async-frame.js"; // (#2865) async-gen fn-expr producer
// (#3164) Native generator FUNCTION EXPRESSIONS (standalone/wasi): the lifted
// closure body emits the state-struct factory instead of the eager-buffer host
// path. `generators-native` does not import `closures`, so no cycle.
import {
  compileNativeGeneratorFunction,
  isNativeGeneratorCandidate,
  registerNativeGenerator,
} from "./generators-native.js";
import type { NativeGeneratorInfo } from "./context/types.js";
// (#3270) Extracted closure subsystems. Re-exported below so external importers
// that reference these symbols via `./closures.js` are unaffected.
import {
  getClosureFuncSelfTypeIdx,
  CLOSURE_CAPTURE_FIELD_BASE,
  getFuncSignature,
  getOrCreateFuncRefWrapperTypes,
  getFuncRefWrapperRootTypeIdx,
} from "./closures/funcref-wrapper-types.js";
import { recordLiftedCaptureSlots as recordCaptureSlots } from "./closures/capture-source-slot.js";
import { EXTERNREF_PARAM, setAccessorParamIsDynamic } from "./closures/set-accessor-param.js";
import { collectTransitiveCaptureNames } from "./function-declaration-observation.js";
import { prepareLiftedFrameDeclarations } from "./closures/lifted-declaration-hoisting.js";
export { getClosureFuncSelfTypeIdx, getFuncSignature, getOrCreateFuncRefWrapperTypes, getFuncRefWrapperRootTypeIdx };
import {
  isVecOrArrayRefType,
  isHostCallbackArgument,
  isDeferredCallbackArgument,
  isJsonReviverArgument,
} from "./closures/callback-classification.js";
export { isVecOrArrayRefType, isHostCallbackArgument, isDeferredCallbackArgument };
import { emitFuncRefAsClosure, materializeHoistedFunctionValueBinding } from "./closures/funcref-as-closure.js";
import { emitUndefined } from "./expressions/late-imports.js";
import { needsImplicitArgumentsObject } from "./helpers/body-uses-arguments.js";
// (#4491) §10.2.11 step 22.a — the mapped-vs-unmapped `arguments` split.
import { isSimpleParameterList, isStrictFunction } from "./helpers/is-strict-function.js";
export { emitFuncRefAsClosure, materializeHoistedFunctionValueBinding };

function emitClosureDefaultReturnValue(
  ctx: CodegenContext,
  fctx: FunctionContext,
  returnType: ValType | null,
  alreadyHasValue: boolean,
): void {
  const lastInstr = fctx.body[fctx.body.length - 1];
  if (returnType?.kind === "externref" && !alreadyHasValue && (!lastInstr || lastInstr.op !== "return")) {
    emitUndefined(ctx, fctx);
    return;
  }
  emitDefaultReturnValue(fctx, returnType, alreadyHasValue);
}
import { spliceNullGuarded, emitDefaultReturnValue } from "./closures/param-emit-helpers.js";
import type { ArrowClosureCapture } from "./closures/arrow-phases.js";
import {
  addWithEnvironmentCaptureNames,
  planAdditionalWithEnvironmentCaptureNames,
  rehydrateWithEnvironmentScopes,
} from "./with-environment-capture.js";
import {
  planClosureCaptures,
  mintClosureStructTypes,
  emitClosureParamDestructuring,
  emitClosureConstruction,
} from "./closures/arrow-phases.js"; // (#3278) arrow/fn-expr closure phase helpers
import {
  collectDirectEvalActivationBindingNames,
  collectDirectEvalBindingNames,
  emitEnsureDirectEvalActivationStatePoolInitialized,
  enclosingFunctionOwnScopeMayReachDirectEval,
  functionMayReachDirectEval,
  RUNTIME_EVAL_STATE_POOL_CAPTURE_NAME,
} from "./direct-eval-environment.js";
import { initializeFunctionPoisonPillContext } from "./function-poison-pill.js";
import {
  emitObjectMethodAsClosure,
  finalizeMethodTrampolines,
  emitCachedMethodClosureAccess,
  ensureMethodClosureSingleton,
  ensureFuncClosureSingleton,
  emitCachedFuncClosureAccess,
} from "./closures/method-trampolines.js";
export {
  emitObjectMethodAsClosure,
  finalizeMethodTrampolines,
  emitCachedMethodClosureAccess,
  ensureMethodClosureSingleton,
  ensureFuncClosureSingleton,
  emitCachedFuncClosureAccess,
};

// ── Arrow function callbacks ──────────────────────────────────────────

function isSymbolIteratorExpression(expr: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(expr) &&
    ts.isIdentifier(expr.expression) &&
    expr.expression.text === "Symbol" &&
    expr.name.text === "iterator"
  );
}

function isAssignedToSymbolIterator(fn: ts.ArrowFunction | ts.FunctionExpression): boolean {
  let current: ts.Node | undefined = fn.parent;
  while (current && !ts.isSourceFile(current)) {
    if (
      ts.isBinaryExpression(current) &&
      current.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isElementAccessExpression(current.left) &&
      isSymbolIteratorExpression(current.left.argumentExpression)
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function inferExplicitClosureReturnType(
  ctx: CodegenContext,
  fn: ts.ArrowFunction | ts.FunctionExpression,
): ValType | null {
  if (ts.isArrowFunction(fn) && !ts.isBlock(fn.body)) {
    return resolveWasmType(ctx, ctx.checker.getTypeAtLocation(fn.body));
  }
  let inferred: ValType | null = null;
  const visit = (node: ts.Node): void => {
    if (node !== fn && (ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isFunctionDeclaration(node))) {
      return;
    }
    if (ts.isReturnStatement(node) && node.expression && inferred === null) {
      inferred = resolveWasmType(ctx, ctx.checker.getTypeAtLocation(node.expression));
      return;
    }
    forEachChild(node, visit);
  };
  visit(fn.body);
  return inferred;
}

/**
 * (#3096) Collect free-variable references that appear in a parameter list's
 * default initializers — both top-level param defaults (`param.initializer`,
 * e.g. `(a, b = outer) => ...`) and defaults / computed keys nested inside a
 * binding pattern (`param.name`, e.g. `([x = outer]) => ...`, `({ [k]: v }) =>
 * ...`). These are part of the function's scope but are NOT reached by scanning
 * the body, so a closure whose ONLY use of an outer variable is in a parameter
 * default would fail to capture it. The `shadowed` set (the function's own
 * locals) excludes the parameters' own binding names, so only genuine outer
 * references are added.
 */
export function collectParamDefaultReferences(
  parameters: ts.NodeArray<ts.ParameterDeclaration>,
  names: Set<string>,
  shadowed: ReadonlySet<string>,
): void {
  for (const param of parameters) {
    // Binding patterns can hold element defaults (`[x = e]`) and computed keys
    // (`{ [k]: v }`) — walk the whole BindingName; own binding names are shadowed.
    if (!ts.isIdentifier(param.name)) {
      collectReferencedIdentifiers(param.name, names, shadowed);
    }
    if (param.initializer) {
      collectReferencedIdentifiers(param.initializer, names, shadowed);
    }
  }
}

/**
 * Collect identifiers that are WRITTEN to within a node tree.
 * Detects: assignment (=, +=, etc.), ++, --.
 *
 * Scope-aware in the same sense as `collectReferencedIdentifiers`: writes to
 * names shadowed by nested function scopes are not collected.
 */
export function collectWrittenIdentifiers(node: ts.Node, names: Set<string>, shadowed?: ReadonlySet<string>): void {
  if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind;
    // Assignment operators
    if (
      op === ts.SyntaxKind.EqualsToken ||
      op === ts.SyntaxKind.PlusEqualsToken ||
      op === ts.SyntaxKind.MinusEqualsToken ||
      op === ts.SyntaxKind.AsteriskEqualsToken ||
      op === ts.SyntaxKind.SlashEqualsToken ||
      op === ts.SyntaxKind.PercentEqualsToken ||
      op === ts.SyntaxKind.AmpersandEqualsToken ||
      op === ts.SyntaxKind.BarEqualsToken ||
      op === ts.SyntaxKind.CaretEqualsToken ||
      op === ts.SyntaxKind.LessThanLessThanEqualsToken ||
      op === ts.SyntaxKind.GreaterThanGreaterThanEqualsToken ||
      op === ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken ||
      op === ts.SyntaxKind.AsteriskAsteriskEqualsToken ||
      op === ts.SyntaxKind.BarBarEqualsToken ||
      op === ts.SyntaxKind.AmpersandAmpersandEqualsToken ||
      op === ts.SyntaxKind.QuestionQuestionEqualsToken
    ) {
      if (ts.isIdentifier(node.left)) {
        if (!shadowed || !shadowed.has(node.left.text)) names.add(node.left.text);
      }
    }
  } else if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
    const op = node.operator;
    if (op === ts.SyntaxKind.PlusPlusToken || op === ts.SyntaxKind.MinusMinusToken) {
      if (ts.isIdentifier(node.operand)) {
        if (!shadowed || !shadowed.has(node.operand.text)) names.add(node.operand.text);
      }
    }
  }
  if (isFunctionScopeBoundary(node)) {
    const merged = new Set<string>(shadowed ?? []);
    addFunctionOwnLocals(node, merged); // (#2103) memoized own-locals
    if (ts.isFunctionExpression(node) && node.name) merged.add(node.name.text);
    forEachChild(node, (child) => collectWrittenIdentifiers(child, names, merged));
    return;
  }
  forEachChild(node, (child) => collectWrittenIdentifiers(child, names, shadowed));
}

/**
 * (#3270 dedup) Apply an identifier collector (`collectReferencedIdentifiers` /
 * `collectWrittenIdentifiers`) across a function `body`: iterate the statements
 * of a block body, or scan a concise-expression body directly. Factors the
 * block-vs-expression fan-out that the arrow-closure and arrow-callback
 * free-variable scans each open-coded identically.
 */
export function collectOverBody(
  collectFn: (node: ts.Node, names: Set<string>, shadowed?: ReadonlySet<string>) => void,
  body: ts.Node,
  names: Set<string>,
  shadowed?: ReadonlySet<string>,
): void {
  if (ts.isBlock(body)) {
    for (const stmt of body.statements) collectFn(stmt, names, shadowed);
  } else {
    collectFn(body, names, shadowed);
  }
}

/**
 * True when every value reference with `name` in a closure resolves to the
 * closure's imported binding. Import bindings are live views of the exporting
 * module, not values captured when a closure is constructed. Keeping one in a
 * capture slot can snapshot the export's pre-initialization null value when a
 * CommonJS/ESM dependency is initialized later in the combined module.
 */
export function closureNameResolvesToImportBinding(
  ctx: CodegenContext,
  closure: ts.ArrowFunction | ts.FunctionExpression,
  name: string,
): boolean {
  let sawReference = false;
  let allReferencesAreImports = true;

  const isImportDeclaration = (declaration: ts.Declaration): boolean =>
    ts.isImportClause(declaration) ||
    ts.isImportSpecifier(declaration) ||
    ts.isNamespaceImport(declaration) ||
    ts.isImportEqualsDeclaration(declaration);

  const isValueReference = (id: ts.Identifier): boolean => {
    const parent = id.parent;
    if (!parent) return true;
    if (ts.isVariableDeclaration(parent) && parent.name === id) return false;
    if (ts.isParameter(parent) && parent.name === id) return false;
    if (ts.isBindingElement(parent) && parent.name === id) return false;
    if (
      (ts.isFunctionDeclaration(parent) ||
        ts.isFunctionExpression(parent) ||
        ts.isClassDeclaration(parent) ||
        ts.isClassExpression(parent)) &&
      parent.name === id
    ) {
      return false;
    }
    if (ts.isPropertyAccessExpression(parent) && parent.name === id) return false;
    if (ts.isPropertyAssignment(parent) && parent.name === id) return false;
    if (ts.isLabeledStatement(parent) && parent.label === id) return false;
    if ((ts.isBreakStatement(parent) || ts.isContinueStatement(parent)) && parent.label === id) return false;
    return true;
  };

  const visit = (node: ts.Node): void => {
    if (!allReferencesAreImports) return;
    if (ts.isIdentifier(node) && node.text === name && isValueReference(node)) {
      sawReference = true;
      const declarations = ctx.oracle.declarationsOf(node);
      if (declarations.length === 0 || !declarations.some(isImportDeclaration)) {
        allReferencesAreImports = false;
        return;
      }
    }
    forEachChild(node, visit);
  };
  visit(closure);
  return sawReference && allReferencesAreImports;
}

/**
 * (#3270 dedup) Compute a function-like node's own-locals shadow set: its
 * memoized own locals (#2103) plus, for a named function expression, its own
 * name (so self-references aren't treated as outer captures). The
 * free-variable, mutated-capture, and callback-capture analyses each built this
 * set identically.
 */
export function arrowOwnLocals(arrow: ts.ArrowFunction | ts.FunctionExpression): Set<string> {
  const ownLocals = new Set<string>();
  addFunctionOwnLocals(arrow, ownLocals); // (#2103) memoized own-locals
  if (ts.isFunctionExpression(arrow) && arrow.name) ownLocals.add(arrow.name.text);
  // (#3398) Only ARROWS inherit the enclosing `this` lexically (§8.1.1.3 —
  // a function expression / object-literal method / accessor binds its OWN
  // dynamic `this` at call time, installed by the closure-call path via
  // `__current_this`). Shadow `this` for non-arrows so the free-var scan
  // never lexically captures the ENCLOSING function's `this`. Concretely: an
  // object-literal getter nested in a struct-method return value
  // (`{ make() { return { index: 0, get val() { return this.index; } } } }`)
  // captured `make`'s `(ref $__anon_N)` self as its `this`, so `this.index`
  // statically resolved against the OUTER struct and the dynamic-property
  // auto-add (property-access-dispatch.ts) APPENDED `index` to that already-
  // emitted struct — `struct.new` arity mismatch, invalid Wasm in BOTH lanes
  // (the #3398 Array.from sub-mechanism). NOTE: callers pass accessor/method
  // declarations force-cast to FunctionExpression — `isArrowFunction` is the
  // only reliable discriminator here.
  if (!ts.isArrowFunction(arrow)) ownLocals.add("this");
  return ownLocals;
}

/**
 * Promote captured locals to globals for getter/setter accessor functions.
 *
 * When an object literal getter/setter references variables from the enclosing
 * function scope, those variables need to be accessible as Wasm globals (since
 * the getter/setter is compiled as a separate Wasm function).
 *
 * This function:
 * 1. Scans the accessor body for referenced identifiers
 * 2. For each that maps to a local in the enclosing fctx, creates a Wasm global
 * 3. Copies the local's current value into the global
 * 4. Removes the name from localMap so subsequent code uses the global
 * 5. Registers in ctx.capturedGlobals for resolution in the accessor body
 */
export function promoteAccessorCapturesToGlobals(
  ctx: CodegenContext,
  fctx: FunctionContext,
  accessorBody: ts.Block | undefined,
  extraNodes?: readonly ts.Node[],
): void {
  if (!accessorBody && (!extraNodes || extraNodes.length === 0)) return;

  const referencedNames = new Set<string>();
  if (accessorBody) {
    for (const stmt of accessorBody.statements) {
      collectReferencedIdentifiers(stmt, referencedNames);
    }
  }
  // Param-default initializers (#1161) also reference captured variables;
  // scan them here so defaults like `[] = iter` can resolve `iter`.
  if (extraNodes) {
    for (const node of extraNodes) {
      collectReferencedIdentifiers(node, referencedNames);
    }
  }

  // (#2029 family A) Transitive captures of referenced NESTED FUNCTIONS.
  // When the accessor body references a nested function declaration (e.g.
  // `get() { return next; }` with `function next() { return count; }` in the
  // enclosing scope), the name `next` itself is skipped below (it is a
  // function reference, not a variable) — but materializing next's closure
  // INSIDE the accessor still needs next's captured variables. Those captures
  // are recorded against the ENCLOSING function's local slots
  // (`cap.outerLocalIdx`), which the accessor's own function cannot read:
  // previously `emitMemoizedNestedFnClosure` / the call-site cap-prepend baked
  // the enclosing function's local index into the accessor body — an emit
  // crash ("local index out of range") when the slot exceeded the accessor's
  // local count, and a silent wrong-local read when it happened to be in
  // range. Promote the transitive captures here, in the enclosing fctx where
  // `cap.outerLocalIdx` is still valid:
  //   - IMMUTABLE captures → plain value-global promotion (added to
  //     `referencedNames`, handled by the main loop below). Value-copy
  //     semantics are preserved: the variable is never written, so the
  //     global always holds the one value the closure would have captured.
  //   - MUTABLE captures → box EAGERLY (same ref-cell + localMap-rebind
  //     pattern the closure builders use) and alias the BOX in a module
  //     global (`ctx.capturedBoxGlobals`). The accessor's closure
  //     materialization then shares the very same cell the enclosing
  //     function writes through — live write-through semantics, not a copy.
  {
    // Names the accessor body references DIRECTLY (before the transitive
    // union below). A mutable capture that is also directly referenced keeps
    // the value-global promotion — the accessor's own read/write paths
    // (identifiers.ts / assignment.ts) resolve via `ctx.capturedGlobals`
    // only; the closure materialization then sources a boxed COPY of the
    // value global (best-effort, no crash) instead of the shared cell.
    const directlyReferenced = new Set(referencedNames);
    const fnWorklist: string[] = [];
    for (const name of referencedNames) {
      if (ctx.funcMap.has(name) && ctx.nestedFuncCaptures.has(name)) fnWorklist.push(name);
    }
    const visitedFns = new Set<string>();
    while (fnWorklist.length > 0) {
      const fnName = fnWorklist.pop()!;
      if (visitedFns.has(fnName)) continue;
      visitedFns.add(fnName);
      const caps = ctx.nestedFuncCaptures.get(fnName);
      if (!caps) continue;
      for (const cap of caps) {
        // A capture can itself be a nested function name — follow it.
        if (ctx.funcMap.has(cap.name) && ctx.nestedFuncCaptures.has(cap.name)) {
          fnWorklist.push(cap.name);
          continue;
        }
        if (!(cap.mutable && cap.valType) || directlyReferenced.has(cap.name)) {
          // Immutable (value-copy semantics preserved: never written), or
          // mutable-but-directly-referenced (accessor read path wins):
          // value-global promotion via the main loop below.
          referencedNames.add(cap.name);
          continue;
        }
        // Mutable: box-promote (shared ref cell aliased in a global).
        if (ctx.capturedBoxGlobals?.has(cap.name)) continue;
        if (ctx.capturedGlobals.has(cap.name) || ctx.moduleGlobals.has(cap.name)) continue;
        const capLocalIdx = fctx.localMap.get(cap.name);
        if (capLocalIdx === undefined) continue;
        const refCellTypeIdx = getOrRegisterRefCellType(ctx, cap.valType);
        let boxedLocalIdx: number;
        if (fctx.boxedCaptures?.has(cap.name)) {
          // Already boxed by a prior closure construction — localMap points
          // at the box; alias that same cell.
          boxedLocalIdx = capLocalIdx;
        } else {
          fctx.body.push({ op: "local.get", index: capLocalIdx });
          fctx.body.push({ op: "struct.new", typeIdx: refCellTypeIdx });
          boxedLocalIdx = allocLocal(fctx, `__boxed_${cap.name}`, {
            kind: "ref",
            typeIdx: refCellTypeIdx,
          });
          fctx.body.push({ op: "local.set", index: boxedLocalIdx });
          fctx.localMap.set(cap.name, boxedLocalIdx);
          if (!fctx.boxedCaptures) fctx.boxedCaptures = new Map();
          fctx.boxedCaptures.set(cap.name, { refCellTypeIdx, valType: cap.valType });
        }
        const boxGlobalIdx = nextModuleGlobalIdx(ctx);
        ctx.mod.globals.push({
          name: `__captured_box_${cap.name}`,
          type: { kind: "ref_null", typeIdx: refCellTypeIdx },
          mutable: true,
          init: [{ op: "ref.null", typeIdx: refCellTypeIdx }],
        });
        fctx.body.push({ op: "local.get", index: boxedLocalIdx });
        fctx.body.push({ op: "global.set", index: boxGlobalIdx });
        (ctx.capturedBoxGlobals ??= new Map()).set(cap.name, { globalIdx: boxGlobalIdx, refCellTypeIdx });
      }
    }
  }

  for (const name of referencedNames) {
    // Skip if already a captured global or module global
    if (ctx.capturedGlobals.has(name)) continue;
    if (ctx.moduleGlobals.has(name)) continue;
    // (#2029 family A) Skip names box-promoted above — their localMap entry
    // now points at the shared ref-cell box; value-promoting that box would
    // orphan the rebind (and the accessor body sources it via
    // `ctx.capturedBoxGlobals`, not `ctx.capturedGlobals`).
    if (ctx.capturedBoxGlobals?.has(name)) continue;

    const localIdx = fctx.localMap.get(name);
    if (localIdx === undefined) continue;

    // Skip 'this' — it's passed as param 0 to the accessor
    if (name === "this") continue;

    // Skip if it's a known function name (not a variable capture)
    // #2669: skip names bound to a *user* function (a function reference, not a
    // captured variable) — but NOT a wasm:js-string builtin import
    // (concat/length/equals/substring/charCodeAt), which lives in funcMap yet
    // must not block capture of a same-named outer local (e.g. the test262
    // `let length = "outer"` dstr template). Discriminate by index.
    if (ctx.funcMap.has(name) && ctx.funcMap.get(name) !== ctx.jsStringImports.get(name)) continue;

    // Get the local's type
    const localType =
      localIdx < fctx.params.length
        ? fctx.params[localIdx]!.type
        : (fctx.locals[localIdx - fctx.params.length]?.type ?? { kind: "f64" as const });

    // Widen non-nullable ref to ref_null for global init
    const globalType: ValType =
      localType.kind === "ref" ? { kind: "ref_null", typeIdx: (localType as { typeIdx: number }).typeIdx } : localType;

    // Create default init for the global
    const init: Instr[] =
      globalType.kind === "f64"
        ? [{ op: "f64.const", value: 0 }]
        : globalType.kind === "i32"
          ? [{ op: "i32.const", value: 0 }]
          : globalType.kind === "externref"
            ? [{ op: "ref.null.extern" }]
            : globalType.kind === "ref_null"
              ? [{ op: "ref.null", typeIdx: (globalType as { typeIdx: number }).typeIdx }]
              : [{ op: "i32.const", value: 0 }];

    const globalIdx = nextModuleGlobalIdx(ctx);
    ctx.mod.globals.push({
      name: `__captured_${name}`,
      type: globalType,
      mutable: true,
      init,
    });

    // Copy current local value into the new global
    fctx.body.push({ op: "local.get", index: localIdx });
    fctx.body.push({ op: "global.set", index: globalIdx });

    // Register as captured global so accessor body resolves via global.get
    ctx.capturedGlobals.set(name, globalIdx);
    if (localType.kind === "ref") {
      ctx.capturedGlobalsWidened.add(name);
    }

    // (#3039) When the promoted local is a BOXED mutable capture (a ref cell:
    // a sibling closure mutates it, so `fctx.boxedCaptures.has(name)`), the
    // global we just created holds the ref-cell BOX, not the scalar value.
    // Register it ADDITIVELY in `capturedBoxGlobals` WITH the inner value type
    // (`valType`), keeping the `capturedGlobals` entry above intact so every
    // unmodified consumer (closure materialization, class-defer heuristic,
    // var-init re-sync) behaves exactly as before. The accessor/method body's
    // scalar read (identifiers.ts) and write (assignment.ts / unary-updates.ts)
    // sites check `capturedBoxGlobals` FIRST and DEREF the box
    // (`global.get; struct.get/struct.set field 0`). Without this, a
    // method-shorthand / class-method / class-accessor that reads or writes a
    // transitively-captured boxed var emits garbage (read → f64/ref default;
    // write → computes the value, drops it, then NULLs the box global).
    const boxedInfo = fctx.boxedCaptures?.get(name);
    if (boxedInfo) {
      (ctx.capturedBoxGlobals ??= new Map()).set(name, {
        globalIdx,
        refCellTypeIdx: boxedInfo.refCellTypeIdx,
        valType: boxedInfo.valType,
      });
    }

    // If this variable has a local TDZ flag, also promote it to a global TDZ flag
    const tdzFlagLocalIdx = fctx.tdzFlagLocals?.get(name);
    if (tdzFlagLocalIdx !== undefined) {
      const tdzGlobalIdx = nextModuleGlobalIdx(ctx);
      ctx.mod.globals.push({
        name: `__tdz_${name}`,
        type: { kind: "i32" },
        mutable: true,
        init: [{ op: "i32.const", value: 0 }],
      });
      // Copy current TDZ flag value to the global. If the flag has been
      // boxed in an i32 ref cell (because a closure captured it — #1177),
      // read it through `struct.get` instead of as a raw i32 local.
      const boxed = fctx.boxedTdzFlags?.get(name);
      if (boxed) {
        fctx.body.push({ op: "local.get", index: boxed.localIdx });
        fctx.body.push({ op: "struct.get", typeIdx: boxed.refCellTypeIdx, fieldIdx: 0 });
      } else {
        fctx.body.push({ op: "local.get", index: tdzFlagLocalIdx });
      }
      fctx.body.push({ op: "global.set", index: tdzGlobalIdx });
      ctx.tdzGlobals.set(name, tdzGlobalIdx);
    }

    // Remove from localMap so subsequent code in the enclosing function
    // also uses the global (maintaining shared state with the accessor)
    fctx.localMap.delete(name);
    // (#3121) Record the promotion so later closure constructions in this
    // function do NOT resurrect the orphaned local slot via the #1177
    // fctx.locals-by-name rescan (which would fork the binding into a second
    // store — a fresh ref cell over the dead local — invisible to the
    // method's global-routed writes). With the name recorded, the closure
    // skips the capture entirely and its lifted body resolves reads/writes
    // through `ctx.capturedGlobals` — the same store as the method body and
    // the enclosing function's own post-promotion references.
    (fctx.promotedCaptureNames ??= new Set()).add(name);
  }
}

/** Check if a name is defined in any of the arrow's own parameters (including destructuring) */
export function isOwnParamName(arrow: ts.ArrowFunction | ts.FunctionExpression, name: string): boolean {
  for (const p of arrow.parameters) {
    if (ts.isIdentifier(p.name) && p.name.text === name) return true;
    if (ts.isObjectBindingPattern(p.name) || ts.isArrayBindingPattern(p.name)) {
      const names = new Set<string>();
      collectBindingPatternNames(p.name, names);
      if (names.has(name)) return true;
    }
  }
  return false;
}

/**
 * Emit destructuring code for an arrow function parameter that uses a binding pattern.
 * The parameter value is already in a local at `paramIdx`; this emits instructions to
 * extract fields/elements into new locals in the lifted function context.
 */
export function emitArrowParamDestructuring(
  ctx: CodegenContext,
  fctx: FunctionContext,
  param: ts.ParameterDeclaration,
  paramIdx: number,
  paramType: ValType,
): void {
  if (ts.isObjectBindingPattern(param.name)) {
    // Object destructuring: const { a, b } = param
    const pattern = param.name;

    // Resolve struct type from the parameter's TS type
    const tsParamType = ctx.checker.getTypeAtLocation(param);
    ensureStructForType(ctx, tsParamType);

    const symName = tsParamType.symbol?.name;
    let typeName =
      symName && symName !== "__type" && symName !== "__object" && ctx.structMap.has(symName)
        ? symName
        : (ctx.anonTypeMap.get(tsParamType) ?? symName);

    if (
      typeName &&
      (typeName === "__type" || typeName === "__object") &&
      !ctx.anonTypeMap.has(tsParamType) &&
      tsParamType.getProperties().length > 0
    ) {
      ensureStructForType(ctx, tsParamType);
      typeName = ctx.anonTypeMap.get(tsParamType) ?? typeName;
    }

    if (!typeName) return;
    const structTypeIdx = ctx.structMap.get(typeName);
    const fields = ctx.structFields.get(typeName);
    if (structTypeIdx === undefined || !fields) return;

    // If the param is externref (e.g. callback from JS host or dynamically typed),
    // try ref.test to see if it's a known Wasm struct; if not, use __extern_get fallback.
    if (paramType.kind === "externref") {
      // Use ref.test to check if externref is actually the expected struct
      // If yes: convert and use struct path. If no: use __extern_get fallback.
      const testLocal = allocLocal(fctx, `__destr_test_${fctx.locals.length}`, { kind: "i32" });
      fctx.body.push({ op: "local.get", index: paramIdx });
      fctx.body.push({ op: "any.convert_extern" });
      fctx.body.push({ op: "ref.test", typeIdx: structTypeIdx });
      fctx.body.push({ op: "local.set", index: testLocal });

      // Struct path (ref.test succeeded)
      const structRefType: ValType = { kind: "ref_null", typeIdx: structTypeIdx };
      const structPath = collectInstrs(fctx, () => {
        const convertedIdx = allocLocal(fctx, `__destr_ref_${fctx.locals.length}`, structRefType);
        fctx.body.push({ op: "local.get", index: paramIdx });
        fctx.body.push({ op: "any.convert_extern" });
        emitGuardedRefCast(fctx, structTypeIdx);
        fctx.body.push({ op: "local.set", index: convertedIdx });

        // Ensure binding locals are allocated (struct path)
        for (const element of pattern.elements) {
          if (!ts.isBindingElement(element)) continue;
          if (ts.isOmittedExpression(element as any)) continue;
          if (!ts.isIdentifier(element.name)) continue;
          const localName = element.name.text;
          const propNameNode = element.propertyName ?? element.name;
          if (!ts.isIdentifier(propNameNode) && !ts.isStringLiteral(propNameNode)) continue;
          const propName = propNameNode.text;
          const fieldIdx = fields.findIndex((f) => f.name === propName);
          if (fieldIdx === -1) {
            reportSilentFallback(ctx, "lookup-miss-skip", "closures:capture-object-pattern-field-miss", element);
            continue;
          }
          const fieldType = fields[fieldIdx]!.type;
          const localIdx = allocLocal(fctx, localName, fieldType);
          fctx.body.push({ op: "local.get", index: convertedIdx });
          fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx });
          fctx.body.push({ op: "local.set", index: localIdx });
        }
      });

      // Externref fallback path (ref.test failed — JS object)
      const externPath = collectInstrs(fctx, () => {
        fctx.body.push({ op: "local.get", index: paramIdx });
        compileExternrefObjectDestructuringDecl(ctx, fctx, pattern, paramType);
      });

      fctx.body.push({ op: "local.get", index: testLocal });
      fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: structPath, else: externPath });
      return; // Skip the rest of the object destructuring logic
    }

    // Null guard for ref_null param types
    const savedBodyAPD = fctx.body;
    const apdInstrs: Instr[] = [];
    fctx.body = apdInstrs;

    // If the parameter is externref but we need a struct, convert it first.
    // This happens in __cb_N callbacks where parameters come from JS host as externref.
    const structParamIdx = paramIdx;

    for (const element of pattern.elements) {
      if (!ts.isBindingElement(element)) continue;
      if (ts.isOmittedExpression(element as any)) continue;
      const propNameNode = element.propertyName ?? element.name;
      if (!ts.isIdentifier(element.name)) {
        continue;
      }
      // propName must be an identifier or string literal to extract field name
      if (!ts.isIdentifier(propNameNode) && !ts.isStringLiteral(propNameNode)) {
        continue;
      }
      const propName = propNameNode as ts.Identifier;
      const localName = element.name.text;

      const fieldIdx = fields.findIndex((f) => f.name === propName.text);
      if (fieldIdx === -1) {
        reportSilentFallback(ctx, "lookup-miss-skip", "closures:capture-binding-element-field-miss", element);
        continue;
      }

      const fieldType = fields[fieldIdx]!.type;
      const localIdx = allocLocal(fctx, localName, fieldType);

      fctx.body.push({ op: "local.get", index: structParamIdx });
      fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx });

      if (element.initializer) {
        if (fieldType.kind === "externref") {
          // Per JS spec: only undefined triggers defaults, NOT null (#796)
          const tmpField = allocLocal(fctx, `__dflt_${fctx.locals.length}`, fieldType);
          fctx.body.push({ op: "local.tee", index: tmpField });
          emitExternIsUndefinedCheck(ctx, fctx);
          const savedBody = pushBody(fctx);
          compileExpression(ctx, fctx, element.initializer, fieldType);
          fctx.body.push({ op: "local.set", index: localIdx });
          const thenInstrs = fctx.body;
          fctx.body = savedBody;
          fctx.body.push({
            op: "if",
            blockType: { kind: "empty" },
            then: thenInstrs,
            else: [
              { op: "local.get", index: tmpField },
              { op: "local.set", index: localIdx },
            ],
          });
        } else if (fieldType.kind === "ref_null" || fieldType.kind === "ref") {
          const tmpField = allocLocal(fctx, `__dflt_${fctx.locals.length}`, fieldType);
          fctx.body.push({ op: "local.tee", index: tmpField });
          fctx.body.push({ op: "ref.is_null" });
          const savedBody = pushBody(fctx);
          compileExpression(ctx, fctx, element.initializer, fieldType);
          fctx.body.push({ op: "local.set", index: localIdx });
          const thenInstrs = fctx.body;
          fctx.body = savedBody;
          fctx.body.push({
            op: "if",
            blockType: { kind: "empty" },
            then: thenInstrs,
            else: [
              { op: "local.get", index: tmpField },
              { op: "local.set", index: localIdx },
            ],
          });
        } else if (fieldType.kind === "f64") {
          const tmpField = allocLocal(fctx, `__dflt_${fctx.locals.length}`, fieldType);
          fctx.body.push({ op: "local.tee", index: tmpField });
          fctx.body.push({ op: "local.get", index: tmpField });
          fctx.body.push({ op: "f64.ne" });
          const savedBody = pushBody(fctx);
          compileExpression(ctx, fctx, element.initializer, fieldType);
          fctx.body.push({ op: "local.set", index: localIdx });
          const thenInstrs = fctx.body;
          fctx.body = savedBody;
          fctx.body.push({
            op: "if",
            blockType: { kind: "empty" },
            then: thenInstrs,
            else: [
              { op: "local.get", index: tmpField },
              { op: "local.set", index: localIdx },
            ],
          });
        } else {
          fctx.body.push({ op: "local.set", index: localIdx });
        }
      } else {
        fctx.body.push({ op: "local.set", index: localIdx });
      }
    }

    // Close null guard
    fctx.body = savedBodyAPD;
    spliceNullGuarded(fctx, paramIdx, paramType.kind === "ref_null", apdInstrs);
  } else if (ts.isArrayBindingPattern(param.name)) {
    // Array destructuring: const [a, b] = param
    const pattern = param.name;

    // If the param is externref (e.g. JS array passed to closure), use __extern_get fallback
    if (paramType.kind === "externref") {
      fctx.body.push({ op: "local.get", index: paramIdx });
      compileExternrefArrayDestructuringDecl(ctx, fctx, pattern, paramType);
      return;
    }

    if (paramType.kind !== "ref" && paramType.kind !== "ref_null") return;

    const vecTypeIdx = (paramType as { typeIdx: number }).typeIdx;
    const innerArrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
    const arrDef = ctx.mod.types[innerArrTypeIdx];
    if (!arrDef || arrDef.kind !== "array") return;

    const innerElemType = arrDef.element;

    // Null guard for ref_null param types
    const savedBodyAPDA = fctx.body;
    const apdaInstrs: Instr[] = [];
    fctx.body = apdaInstrs;

    for (let i = 0; i < pattern.elements.length; i++) {
      const element = pattern.elements[i]!;
      if (ts.isOmittedExpression(element)) continue;
      const bindingElem = element as ts.BindingElement;
      if (!ts.isIdentifier(bindingElem.name)) continue;

      const localName = (bindingElem.name as ts.Identifier).text;
      const bindingTsType = ctx.checker.getTypeAtLocation(element);
      const bindingWasmType = resolveWasmType(ctx, bindingTsType);
      const localIdx = allocLocal(fctx, localName, bindingWasmType);

      fctx.body.push({ op: "local.get", index: paramIdx });
      fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
      fctx.body.push({ op: "i32.const", value: i });
      emitBoundsCheckedArrayGet(fctx, innerArrTypeIdx, innerElemType);

      if (!valTypesMatch(innerElemType, bindingWasmType)) {
        coerceType(ctx, fctx, innerElemType, bindingWasmType);
      }

      // Handle default initializer: [x = 23] — apply default when value is undefined
      if (bindingElem.initializer) {
        if (bindingWasmType.kind === "externref") {
          // Per JS spec: only undefined triggers defaults, NOT null (#796)
          const tmpElem = allocLocal(fctx, `__ary_dflt_${fctx.locals.length}`, bindingWasmType);
          fctx.body.push({ op: "local.tee", index: tmpElem });
          emitExternIsUndefinedCheck(ctx, fctx);
          const savedBody = pushBody(fctx);
          compileExpression(ctx, fctx, bindingElem.initializer, bindingWasmType);
          fctx.body.push({ op: "local.set", index: localIdx });
          const thenInstrs = fctx.body;
          fctx.body = savedBody;
          fctx.body.push({
            op: "if",
            blockType: { kind: "empty" },
            then: thenInstrs,
            else: [
              { op: "local.get", index: tmpElem },
              { op: "local.set", index: localIdx },
            ],
          });
        } else if (bindingWasmType.kind === "ref_null" || bindingWasmType.kind === "ref") {
          // Internal struct refs: use ref.is_null for missing values
          const tmpElem = allocLocal(fctx, `__ary_dflt_${fctx.locals.length}`, bindingWasmType);
          fctx.body.push({ op: "local.tee", index: tmpElem });
          fctx.body.push({ op: "ref.is_null" });
          const savedBody = pushBody(fctx);
          compileExpression(ctx, fctx, bindingElem.initializer, bindingWasmType);
          fctx.body.push({ op: "local.set", index: localIdx });
          const thenInstrs = fctx.body;
          fctx.body = savedBody;
          fctx.body.push({
            op: "if",
            blockType: { kind: "empty" },
            then: thenInstrs,
            else: [
              { op: "local.get", index: tmpElem },
              { op: "local.set", index: localIdx },
            ],
          });
        } else if (bindingWasmType.kind === "f64") {
          // f64: undefined is NaN, check NaN self-test
          const tmpElem = allocLocal(fctx, `__ary_dflt_${fctx.locals.length}`, bindingWasmType);
          fctx.body.push({ op: "local.tee", index: tmpElem });
          fctx.body.push({ op: "local.get", index: tmpElem });
          fctx.body.push({ op: "f64.ne" });
          const savedBody = pushBody(fctx);
          compileExpression(ctx, fctx, bindingElem.initializer, bindingWasmType);
          fctx.body.push({ op: "local.set", index: localIdx });
          const thenInstrs = fctx.body;
          fctx.body = savedBody;
          fctx.body.push({
            op: "if",
            blockType: { kind: "empty" },
            then: thenInstrs,
            else: [
              { op: "local.get", index: tmpElem },
              { op: "local.set", index: localIdx },
            ],
          });
        } else {
          // i32/other: no reliable sentinel, just set directly
          fctx.body.push({ op: "local.set", index: localIdx });
        }
      } else {
        fctx.body.push({ op: "local.set", index: localIdx });
      }
    }

    // Close null guard
    fctx.body = savedBodyAPDA;
    spliceNullGuarded(fctx, paramIdx, paramType.kind === "ref_null", apdaInstrs);
  }
}

/**
 * Emit the sentinel check + conditional default assignment for a parameter.
 */
function emitParamDefaultCheckInline(
  ctx: CodegenContext,
  fctx: FunctionContext,
  paramIdx: number,
  paramType: ValType,
  thenInstrs: Instr[],
  argIndex: number,
  argcLocal: number | undefined,
): void {
  if (paramType.kind === "externref") {
    // Per JS spec, parameter defaults fire ONLY when the arg is `undefined`
    // (omitted or explicit), never for `null`. Callers pad missing args with
    // `__get_undefined()` (externref-wrapped undefined), so
    // `__extern_is_undefined` catches both "omitted" and "explicit undefined".
    // Using `ref.is_null` in addition would wrongly fire the default when the
    // caller passed explicit `null` (#1025 / #1021).
    const undefIdx = ensureExternIsUndefinedImport(ctx, fctx);
    fctx.body.push({ op: "local.get", index: paramIdx });
    if (undefIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx: undefIdx });
    } else {
      // Fallback (standalone mode): ref.is_null is imprecise — treats null
      // as undefined.
      fctx.body.push({ op: "ref.is_null" });
    }
    fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: thenInstrs });
  } else if (paramType.kind === "ref_null" || paramType.kind === "ref") {
    fctx.body.push({ op: "local.get", index: paramIdx });
    fctx.body.push({ op: "ref.is_null" });
    fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: thenInstrs });
  } else if (paramType.kind === "i32") {
    emitParamDefaultArgMissingCheck(fctx, argcLocal!, argIndex);
    fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: thenInstrs });
  } else if (paramType.kind === "f64") {
    emitParamDefaultArgMissingCheck(fctx, argcLocal!, argIndex);
    emitF64ParamSentinelCheck(fctx, paramIdx);
    fctx.body.push({ op: "i32.or" });
    fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: thenInstrs });
  }
}

/**
 * Emit default-value initialization for arrow/closure function parameters.
 * Similar to the logic in compileFunctionBody but operates on the lifted fctx.
 */
export function emitArrowParamDefaults(
  ctx: CodegenContext,
  fctx: FunctionContext,
  arrow: ts.ArrowFunction | ts.FunctionExpression,
  paramOffset: number, // offset in liftedFctx.params (usually 1 for __self)
): void {
  // (#3359) Iterate the this-param-stripped list so index `i` stays aligned with
  // `fctx.params[paramOffset + i]` (which was built without the TS `this` param).
  const params = runtimeParameters(arrow);
  // TDZ enforcement (#413): set up TDZ flags for parameters with defaults
  const hasDefaults = params.some((p) => !!p.initializer);
  let tdzFlags: number[] | undefined;
  if (hasDefaults) {
    if (!fctx.tdzFlagLocals) fctx.tdzFlagLocals = new Map();
    tdzFlags = [];
    for (let i = 0; i < params.length; i++) {
      const param = params[i]!;
      const paramName = ts.isIdentifier(param.name) ? param.name.text : `__param${i}`;
      const flagIdx = allocLocal(fctx, `__tdz_param_${paramName}`, { kind: "i32" });
      tdzFlags.push(flagIdx);
      fctx.tdzFlagLocals.set(paramName, flagIdx);
    }
  }
  const defaultArgcLocal =
    hasDefaults &&
    params.some((param, i) => {
      if (!param.initializer) return false;
      return paramDefaultNeedsArgc(fctx.params[paramOffset + i]?.type);
    })
      ? cacheParamDefaultArgc(ctx, fctx)
      : undefined;

  for (let i = 0; i < params.length; i++) {
    const param = params[i]!;
    if (!param.initializer) {
      if (tdzFlags) {
        fctx.body.push({ op: "i32.const", value: 1 });
        fctx.body.push({ op: "local.set", index: tdzFlags[i]! });
      }
      continue;
    }

    const paramIdx = paramOffset + i;
    const paramType = fctx.params[paramIdx]?.type;
    if (!paramType) continue;

    // Pre-ensure `__extern_is_undefined` before compiling the initializer so any
    // late-import funcIdx shift happens while `fctx.body` is still authoritative.
    // Without this, the initializer compiles into `thenInstrs`, which gets
    // detached from `fctx` after the body swap below — any subsequent shift
    // triggered by ensureLateImport inside emitParamDefaultCheckInline would
    // miss `thenInstrs`, leaving stale funcIdx values in its `call` ops.
    if (paramType.kind === "externref") {
      ensureExternIsUndefinedImport(ctx, fctx);
    }

    // Per spec §14.3.3.1/§8.4.2: throw TypeError when destructuring null/undefined.
    const dstrNullDefault =
      (ts.isObjectBindingPattern(param.name) || ts.isArrayBindingPattern(param.name)) &&
      isNullOrUndefinedLiteral(param.initializer);

    // Build the "then" block: compile default expression, local.set
    const savedBody = pushBody(fctx);
    if (dstrNullDefault) {
      for (const ins of buildDestructureNullThrow(ctx, fctx)) fctx.body.push(ins);
    } else {
      // For array binding patterns with externref param, force default literals
      // to compile as vec (not tuple) so the destructure path can convert them.
      const isArrayPatternExternref = ts.isArrayBindingPattern(param.name) && paramType.kind === "externref";
      const prevForceVec = (ctx as unknown as { _arrayLiteralForceVec?: boolean })._arrayLiteralForceVec;
      if (isArrayPatternExternref) {
        (ctx as unknown as { _arrayLiteralForceVec?: boolean })._arrayLiteralForceVec = true;
      }
      // (#3333) Host-free lanes, `any`-typed OBJECT pattern (no struct type
      // resolves from the pattern): a default object LITERAL compiled against
      // the bare externref hint materializes a typed anonymous struct the
      // destructure's dynamic `__extern_get` reader cannot reflect — every
      // binding read NaN. Build it through `compileObjectLiteralAsExternref`
      // (the `__new_plain_object` dynamic carrier) instead. Mirrors the
      // function-declaration site in function-body.ts.
      const dynObjCarrier =
        (ctx.standalone || ctx.wasi) &&
        ts.isObjectBindingPattern(param.name) &&
        paramType.kind === "externref" &&
        ts.isObjectLiteralExpression(param.initializer) &&
        structHintForBindingPattern(ctx, param.name) === undefined;
      try {
        if (dynObjCarrier) {
          const t = compileObjectLiteralAsExternref(ctx, fctx, param.initializer as ts.ObjectLiteralExpression);
          if (t === null) compileExpression(ctx, fctx, param.initializer, paramType);
        } else {
          compileExpression(ctx, fctx, param.initializer, paramType);
        }
      } finally {
        if (isArrayPatternExternref) {
          (ctx as unknown as { _arrayLiteralForceVec?: boolean })._arrayLiteralForceVec = prevForceVec;
        }
      }
      fctx.body.push({ op: "local.set", index: paramIdx });
    }
    const thenInstrs = fctx.body;
    fctx.body = savedBody;

    // Emit the null/zero check + conditional assignment
    emitParamDefaultCheckInline(ctx, fctx, paramIdx, paramType, thenInstrs, i, defaultArgcLocal);
    // Mark param as initialized after the if
    if (tdzFlags) {
      fctx.body.push({ op: "i32.const", value: 1 });
      fctx.body.push({ op: "local.set", index: tdzFlags[i]! });
    }
  }

  // Clean up param TDZ flags
  if (tdzFlags) {
    for (let i = 0; i < params.length; i++) {
      const param = params[i]!;
      const paramName = ts.isIdentifier(param.name) ? param.name.text : `__param${i}`;
      fctx.tdzFlagLocals?.delete(paramName);
    }
    if (fctx.tdzFlagLocals?.size === 0) fctx.tdzFlagLocals = undefined;
  }
}

/**
 * Emit default-value initialization for method/setter parameters with initializers.
 * For each param with a default value, check if the caller omitted it
 * (externref -> ref.is_null, i32 -> i32.eqz, f64 -> f64.eq 0.0) and if so
 * compile the initializer expression and assign it to the param local.
 */
export function emitMethodParamDefaults(
  ctx: CodegenContext,
  fctx: FunctionContext,
  params: ts.NodeArray<ts.ParameterDeclaration>,
  paramOffset: number, // offset in fctx.params (usually 1 for 'this')
): void {
  // TDZ enforcement (#413)
  const hasDefaults = params.some((p) => !!p.initializer);
  let tdzFlags: number[] | undefined;
  if (hasDefaults) {
    if (!fctx.tdzFlagLocals) fctx.tdzFlagLocals = new Map();
    tdzFlags = [];
    for (let i = 0; i < params.length; i++) {
      const param = params[i]!;
      const paramName = ts.isIdentifier(param.name) ? param.name.text : `__param${i}`;
      const flagIdx = allocLocal(fctx, `__tdz_param_${paramName}`, { kind: "i32" });
      tdzFlags.push(flagIdx);
      fctx.tdzFlagLocals.set(paramName, flagIdx);
    }
  }
  const defaultArgcLocal =
    hasDefaults &&
    params.some((param, i) => {
      if (!param.initializer) return false;
      return paramDefaultNeedsArgc(fctx.params[paramOffset + i]?.type);
    })
      ? cacheParamDefaultArgc(ctx, fctx)
      : undefined;

  for (let i = 0; i < params.length; i++) {
    const param = params[i]!;
    if (!param.initializer) {
      if (tdzFlags) {
        fctx.body.push({ op: "i32.const", value: 1 });
        fctx.body.push({ op: "local.set", index: tdzFlags[i]! });
      }
      continue;
    }

    const paramIdx = paramOffset + i;
    const paramType = fctx.params[paramIdx]?.type;
    if (!paramType) continue;

    // Pre-ensure `__extern_is_undefined` before compiling the initializer — see
    // rationale above in emitArrowParamDefaults. Without this, a late-import
    // shift inside emitParamDefaultCheckInline misses the detached thenInstrs.
    if (paramType.kind === "externref") {
      ensureExternIsUndefinedImport(ctx, fctx);
    }

    // Per spec §14.3.3.1/§8.4.2: throw TypeError when destructuring null/undefined.
    const dstrNullDefault =
      (ts.isObjectBindingPattern(param.name) || ts.isArrayBindingPattern(param.name)) &&
      isNullOrUndefinedLiteral(param.initializer);

    // Build the "then" block: compile default expression, local.set
    const savedBody = pushBody(fctx);
    if (dstrNullDefault) {
      for (const ins of buildDestructureNullThrow(ctx, fctx)) fctx.body.push(ins);
    } else {
      const isArrayPatternExternref = ts.isArrayBindingPattern(param.name) && paramType.kind === "externref";
      const prevForceVec = (ctx as unknown as { _arrayLiteralForceVec?: boolean })._arrayLiteralForceVec;
      if (isArrayPatternExternref) {
        (ctx as unknown as { _arrayLiteralForceVec?: boolean })._arrayLiteralForceVec = true;
      }
      try {
        compileExpression(ctx, fctx, param.initializer, paramType);
      } finally {
        if (isArrayPatternExternref) {
          (ctx as unknown as { _arrayLiteralForceVec?: boolean })._arrayLiteralForceVec = prevForceVec;
        }
      }
      fctx.body.push({ op: "local.set", index: paramIdx });
    }
    const thenInstrs = fctx.body;
    fctx.body = savedBody;

    emitParamDefaultCheckInline(ctx, fctx, paramIdx, paramType, thenInstrs, i, defaultArgcLocal);
    if (tdzFlags) {
      fctx.body.push({ op: "i32.const", value: 1 });
      fctx.body.push({ op: "local.set", index: tdzFlags[i]! });
    }
  }

  // Clean up param TDZ flags
  if (tdzFlags) {
    for (let i = 0; i < params.length; i++) {
      const param = params[i]!;
      const paramName = ts.isIdentifier(param.name) ? param.name.text : `__param${i}`;
      fctx.tdzFlagLocals?.delete(paramName);
    }
    if (fctx.tdzFlagLocals?.size === 0) fctx.tdzFlagLocals = undefined;
  }
}

/**
 * #1177: Returns true if the closure (`arrow`) is provably constructed AFTER
 * the let/const/using declaration of `name` AND the closure is NOT inside a
 * loop that wraps the declaration. In that case, we don't need to force-box
 * the value — the variable is already initialized when the closure is built,
 * and no closure invocation can observe TDZ.
 *
 * Critical for for-let-iter: `for (let i = 0; ...) { closures.push(() => i); }`
 * — each iteration's closure is built AFTER `i` is initialized in that
 * iteration. Force-boxing here would break per-iteration semantics (all
 * closures would share the same Wasm box slot, observing the final value).
 */
/** (#2705) True if `node` is `ancestor` or a descendant of it. */
function isNodeDescendantOf(node: ts.Node | undefined, ancestor: ts.Node | undefined): boolean {
  if (!ancestor) return false;
  let cur: ts.Node | undefined = node;
  while (cur) {
    if (cur === ancestor) return true;
    cur = cur.parent;
  }
  return false;
}

export function closureProvablyAfterLetDecl(
  ctx: CodegenContext,
  arrow: ts.ArrowFunction | ts.FunctionExpression,
  name: string,
): boolean {
  const sym = ctx.checker.getSymbolsInScope(arrow, ts.SymbolFlags.Variable).find((s) => s.name === name);
  if (!sym) return false;
  const decl = sym.valueDeclaration;
  if (!decl) return false;

  const closureStart = arrow.getStart();
  const declEnd = decl.getEnd();

  // closureStart < declEnd: closure is textually before the decl — TDZ risk.
  if (closureStart < declEnd) return false;

  // Walk up from the closure to find an enclosing loop. If a loop wraps the
  // closure AND the decl is inside that loop's initializer (for-let case) or
  // outside the body, force-boxing would break per-iteration semantics. Stop
  // at function boundaries.
  let cur: ts.Node | undefined = arrow.parent;
  while (cur) {
    if (
      ts.isFunctionDeclaration(cur) ||
      ts.isFunctionExpression(cur) ||
      ts.isArrowFunction(cur) ||
      ts.isMethodDeclaration(cur) ||
      ts.isSourceFile(cur)
    ) {
      // Reached function boundary without finding a wrapping loop.
      return true;
    }
    if (
      ts.isForStatement(cur) ||
      ts.isForInStatement(cur) ||
      ts.isForOfStatement(cur) ||
      ts.isWhileStatement(cur) ||
      ts.isDoStatement(cur)
    ) {
      // Check if decl is descendant of this loop.
      let d: ts.Node | undefined = decl;
      while (d) {
        if (d === cur) {
          // (#2705) Exception: a `for (let/const <head> in/of RECEIVER)` whose
          // RECEIVER builds a closure capturing the HEAD binding. Per §14.7.5.6
          // ForIn/OfHeadEvaluation step 2, the receiver is evaluated in a TDZ
          // environment where the head binding is NOT yet initialized — distinct
          // from the per-iteration environment. A closure inside the receiver
          // therefore captures a binding that stays in its TDZ forever, so its
          // read/`typeof` MUST throw — it is a TDZ risk. Detect: for-in/for-of,
          // decl is the head (`cur.initializer`), closure is in the receiver
          // (`cur.expression`).
          if (ts.isForInStatement(cur) || ts.isForOfStatement(cur)) {
            if (isNodeDescendantOf(arrow, cur.expression) && isNodeDescendantOf(decl, cur.initializer)) {
              return false; // head binding is in TDZ while the receiver is evaluated
            }
          }
          // Decl is inside (or part of) this loop. The loop wraps both
          // the decl and the closure — per-iteration semantics apply,
          // closure runs after decl in each iteration, no TDZ risk.
          return true;
        }
        d = d.parent;
      }
      // Loop doesn't wrap decl — keep walking up.
    }
    cur = cur.parent;
  }
  return true;
}

/**
 * (#3359) Drop a leading TS `this` parameter (`function (this: T, …)`) — a
 * type-level-only annotation that must NOT become a runtime Wasm param, else a
 * real user param shifts one slot right and the array-method call site (which
 * supplies `thisArg` via the `__current_this` global) misaligns. No-this
 * closures (all JS, incl. every test262 input) return the original — byte-identical.
 */
export function runtimeParameters(arrow: ts.ArrowFunction | ts.FunctionExpression): readonly ts.ParameterDeclaration[] {
  const ps = arrow.parameters;
  const first = ps.length > 0 ? ps[0]! : undefined;
  if (first && ts.isIdentifier(first.name) && first.name.escapedText === "this") {
    return ps.slice(1);
  }
  return ps;
}

/**
 * (#4249) True for a declaration the TS **binder never visited** — it has no
 * `symbol`, so every checker query that resolves through one (notably
 * `getSignatureFromDeclaration`, which does `getDeclarationOfKind(symbol, …)`)
 * throws `Cannot read properties of undefined (reading 'declarations' |
 * 'escapedName')` rather than returning `undefined`.
 *
 * The only such nodes in the compiler are foreign ASTs spliced in from a bare
 * `ts.createSourceFile` parse — today, the eval-inline lifter
 * (`src/codegen/expressions/eval-inline.ts`). `allNodesInlineSupported` bails on
 * the node kinds whose codegen it knew reached the checker (function/arrow
 * expressions, classes), but object-literal **accessors** were missed: they are
 * fed to `compileArrowAsClosure` through an `as unknown as ts.FunctionExpression`
 * cast in `emitObjectLiteralAccessorFn`, so `eval("o = {get foo(){…}}")` crashed
 * the whole compile in the standalone lane.
 *
 * Widening the eval bail list instead would have been wrong: on the gc lane the
 * same splice compiles fine (it routes to `compileArrowAsCallback`, which asks
 * the checker nothing) and five test262 files PASS through it — bailing would
 * have traded a standalone crash for a gc regression.
 */
function declarationIsUnbound(decl: ts.Declaration): boolean {
  return (decl as { symbol?: ts.Symbol }).symbol === undefined;
}

/**
 * (#4249) The syntactic stand-in for a return type when the checker cannot be
 * asked (see `declarationIsUnbound`). A body with any value-carrying `return`
 * yields a value; anything else is void. Nested functions are not descended
 * into — their `return`s belong to them, not to `fn`.
 */
function unboundClosureReturnsAValue(fn: ts.ArrowFunction | ts.FunctionExpression): boolean {
  const body = fn.body;
  if (body === undefined) return false;
  if (!ts.isBlock(body)) return true; // concise arrow body — always a value
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (
      ts.isFunctionDeclaration(n) ||
      ts.isFunctionExpression(n) ||
      ts.isArrowFunction(n) ||
      ts.isClassDeclaration(n) ||
      ts.isClassExpression(n) ||
      ts.isMethodDeclaration(n) ||
      ts.isGetAccessorDeclaration(n) ||
      ts.isSetAccessorDeclaration(n)
    ) {
      return; // a nested function's `return` is not ours
    }
    if (ts.isReturnStatement(n) && n.expression !== undefined) {
      found = true;
      return;
    }
    n.forEachChild(visit);
  };
  body.forEachChild(visit);
  return found;
}

/**
 * (#2939) Compute the funcref-wrapper signature (user param ValTypes + return
 * ValType) of an arrow / function-expression closure, WITHOUT emitting anything.
 *
 * This is the exact param+return-type logic `compileArrowAsClosure` uses to
 * build its `getOrCreateFuncRefWrapperTypes(params, results)` wrapper type,
 * factored out so the dynamic-dispatch candidate pre-scan
 * (`ensureFuncValueWrappersRegistered`) can pre-register the SAME wrapper type
 * for a callback function-expression defined in an inner scope — otherwise its
 * wrapper is registered only LAZILY at the (later-compiled) value site, so an
 * earlier-compiled higher-order body that dispatches the callback
 * (`tryEmitInlineDynamicCall`) sees ZERO candidates and silently drops the call
 * (the #2939 nested-scope gap: the test262 `testWith*Constructors(function(TA){…})`
 * harness wrapper, ~814 vacuous passes). Capture analysis is intentionally NOT
 * replicated here — the dispatch keys on the funcref signature (funcTypeIdx),
 * which a capturing closure's custom subtype shares with this base wrapper.
 *
 * Pure: reads only `ctx` + the checker; no side effects, no `fctx`.
 */
export function computeClosureWrapperSig(
  ctx: CodegenContext,
  arrow: ts.ArrowFunction | ts.FunctionExpression,
): { params: ValType[]; returnType: ValType | null } {
  const isGenerator = ts.isFunctionExpression(arrow) && arrow.asteriskToken !== undefined;

  // (#4249) A foreign, never-bound declaration (an eval-inline splice) cannot be
  // asked ANY symbol-resolving question. Answer it syntactically instead — which
  // is also the semantically right answer, since such a body is untyped JS:
  // every parameter is `any` (externref) and the return is externref iff the
  // body returns a value. Skipping the checker here is what keeps
  // `eval("o = {get foo(){…}}")` from taking down the whole compile.
  if (declarationIsUnbound(arrow)) {
    return {
      params: runtimeParameters(arrow).map(() => ({ kind: "externref" as const })),
      returnType: isGenerator || unboundClosureReturnsAValue(arrow) ? { kind: "externref" } : null,
    };
  }

  // 1. Parameter types. (#3359) A TS `this` param is type-level only — exclude it.
  const arrowParams: ValType[] = [];
  for (const p of runtimeParameters(arrow)) {
    const paramType = ctx.checker.getTypeAtLocation(p);
    let wasmType = setAccessorParamIsDynamic(arrow) ? EXTERNREF_PARAM : resolveWasmType(ctx, paramType);
    // An unannotated JavaScript parameter whose default is object-valued is
    // still structurally open: callers may supply any property bag. TypeScript
    // infers the default's exact closed shape, but using that shape as the Wasm
    // ABI rejects narrower custom maps (Hono's getMimeType(filename, mimes =
    // baseMimes)). Keep the call boundary dynamic; the body already performs
    // ordinary computed-property reads through the externref object path.
    if (
      /\.(?:[cm]?js|jsx)$/i.test(p.getSourceFile().fileName) &&
      p.type === undefined &&
      ts.getJSDocType(p) === undefined &&
      p.initializer !== undefined &&
      (wasmType.kind === "ref" || wasmType.kind === "ref_null")
    ) {
      wasmType = { kind: "externref" };
    }
    if (p.initializer && wasmType.kind === "ref") {
      wasmType = { kind: "ref_null", typeIdx: (wasmType as { kind: "ref"; typeIdx: number }).typeIdx };
    }
    const hasBindingPattern = ts.isArrayBindingPattern(p.name) || ts.isObjectBindingPattern(p.name);
    if (hasBindingPattern && wasmType.kind !== "externref") {
      wasmType = { kind: "externref" };
    }
    if (ctx.forceExternrefCallbackParams && isVecOrArrayRefType(ctx, wasmType)) {
      wasmType = { kind: "externref" };
    }
    // (#3137) TUPLE-typed params of a native `.then`/`.catch` callback widen to
    // externref. TS contextually types combinator callbacks over tuple inputs
    // as tuples (`Promise.allSettled([x]).then((rs) => …)` ⇒ rs:
    // `[PromiseSettledResult<…>]`, lowered to a concrete 1-field struct), but
    // the native then-wrapper ABI always delivers externref — the combinator
    // results vec can never BE that tuple struct, so the wrapper's `ref.cast`
    // trapped (illegal cast in __then_fulfill_N). Widened, the body reads the
    // value through the dynamic reader (vec length/index + status objects),
    // which is representation-correct for both the combinator vec and a
    // genuine tuple value. Scoped to the then-callback compile window
    // (`widenTupleCallbackParams`, set in compileStandalonePromiseThenCallback)
    // so every other closure compile is byte-identical.
    if (
      ctx.widenTupleCallbackParams === true &&
      (wasmType.kind === "ref" || wasmType.kind === "ref_null") &&
      isTupleType(paramType)
    ) {
      wasmType = { kind: "externref" };
    }
    arrowParams.push(wasmType);
  }

  // 2. Return type (mirrors compileArrowAsClosure).
  const isAsync = arrow.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ?? false;
  const sig = ctx.checker.getSignatureFromDeclaration(arrow);
  let closureReturnType: ValType | null = null;
  if (isGenerator) {
    closureReturnType = { kind: "externref" };
  } else if (sig) {
    let retType = ctx.checker.getReturnTypeOfSignature(sig);
    if (isAsync) {
      retType = unwrapPromiseType(retType, ctx.checker);
    }
    if (!isAsync && isStandalonePromiseActive(ctx) && isPromiseType(retType)) {
      closureReturnType = { kind: "externref" };
    }
    if (closureReturnType === null && !isVoidType(retType) && !(retType.flags & ts.TypeFlags.Never)) {
      // (#3051 Slice 3) accessor-bearing object-literal return types lower to
      // externref — the runtime value is a HOST plain object; a struct-typed
      // return null-drops it on the failed ref.test (see
      // resolveWasmTypeForClosureReturn).
      closureReturnType = widenClosureReturnForPreInitVar(ctx, arrow, resolveWasmTypeForClosureReturn(ctx, retType));
    }
  }
  if (closureReturnType === null && isAssignedToSymbolIterator(arrow)) {
    closureReturnType = inferExplicitClosureReturnType(ctx, arrow);
  }
  if (closureReturnType !== null) {
    const ctxType = ctx.checker.getContextualType(arrow);
    if (ctxType) {
      const ctxCallSigs = ctxType.getCallSignatures?.();
      if (ctxCallSigs && ctxCallSigs.length > 0) {
        const ctxRetType = ctx.checker.getReturnTypeOfSignature(ctxCallSigs[0]!);
        if (isVoidType(ctxRetType) && !isAssignedToSymbolIterator(arrow)) {
          closureReturnType = null;
        }
      }
    }
  }

  return { params: arrowParams, returnType: closureReturnType };
}

/**
 * (#3032 / #2141-S2) Lazy generator-expression support flag.
 *
 * A `mut i32` module global (0 = lazy, the default) plus an exported
 * `__gen_set_eager(i32)` setter the HOST generator runtime flips around the
 * deferred body run. Mechanism: a zero-param `function*(){...}` expression's
 * closure no longer runs its body at creation; with the flag 0 it returns
 * `__create_generator(<self closure as externref>, null)` — the host detects
 * the non-Array first arg as a LAZY THUNK and defers. On the first `next()`
 * the host sets the flag via `__gen_set_eager(1)`, re-invokes the SAME
 * closure through the `__call_fn_0` export (the closure then takes the
 * historical eager-buffer path, byte-for-byte), adopts the inner generator's
 * state, and resets the flag. The eager arm clears the flag at its TOP so
 * generator creations nested inside the eagerly-run body are themselves lazy
 * again (one flag serves the whole module without leaking eagerness).
 *
 * Why: the eager-buffer lowering ran generator bodies AT CREATION — the
 * test262 dstr fixture `var iter = function*() { iterations += 1; }();` had
 * `iterations === 1` before any `next()`, a latent failure masked only by the
 * tag-5 comparator vacuity (#2141-S2 root cause; see the issue file).
 */
function ensureGenEagerFlag(ctx: CodegenContext): number {
  if (ctx.genEagerFlagGlobalIdx !== undefined) return ctx.genEagerFlagGlobalIdx;
  const globalIdx = ctx.numImportGlobals + ctx.mod.globals.length;
  ctx.mod.globals.push({
    name: "__gen_eager_mode",
    type: { kind: "i32" },
    mutable: true,
    init: [{ op: "i32.const", value: 0 }],
  });
  ctx.genEagerFlagGlobalIdx = globalIdx;
  if (!ctx.funcMap.has("__gen_set_eager")) {
    const typeIdx = addFuncType(ctx, [{ kind: "i32" }], [], "__gen_set_eager");
    const funcIdx = mintDefinedFunc(ctx);
    pushDefinedFunc(ctx, funcIdx, {
      name: "__gen_set_eager",
      typeIdx,
      locals: [],
      body: [
        { op: "local.get", index: 0 },
        { op: "global.set", index: globalIdx },
      ],
      exported: true,
    });
    ctx.funcMap.set("__gen_set_eager", funcIdx);
    ctx.mod.exports.push({
      name: "__gen_set_eager",
      desc: { kind: "func", index: funcIdx },
    });
  }
  return globalIdx;
}

/**
 * (#3032) True when a generator-expression body references `this`/`super`
 * from ITS OWN function scope (nested arrows inherit the generator's `this`
 * and count; nested function expressions / methods / classes have their own
 * `this` binding and do not). Such a generator is lazy-INELIGIBLE: the
 * receiver is call-time state the deferred `__call_fn_0` re-invocation
 * cannot rebind (#3032 W2 spills it).
 */
export function genBodyReferencesThis(node: ts.Node): boolean {
  if (node.kind === ts.SyntaxKind.ThisKeyword || node.kind === ts.SyntaxKind.SuperKeyword) return true;
  if (
    ts.isFunctionExpression(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isClassLike(node)
  ) {
    return false; // own `this` binding — not the generator's receiver
  }
  let found = false;
  forEachChild(node, (child) => {
    if (!found && genBodyReferencesThis(child)) found = true;
  });
  return found;
}

/**
 * (#3132 S2) True when `method` (an async-gen method being considered for the
 * native drive) sits inside an enclosing FUNCTION whose scope declares a name
 * that is ALSO declared at module scope, and the method body references that
 * name. In that shadowing shape the nested-class/object-literal capture
 * promotion mis-binds the method body to the MODULE-scope global while sibling
 * closures (e.g. a `.then` callback) bind the shadowing function-local — two
 * divergent storages for one JS binding (a PRE-EXISTING bug, observable on the
 * JS-host lane today; test262's dstr `ary-elision-iter` template hits it via
 * the wrapper's partial var-hoisting). Until the promotion bug is fixed, the
 * carrier PRE-PASS treats such a method as non-drivable so the module keeps
 * the host Promise pipeline — `.then` callbacks stay host-routed and the
 * divergence is not newly exposed to the standalone floor (correct-or-legacy).
 * Over-approximates in the exclusion direction (names declared ANYWHERE in the
 * enclosing functions count, and own body locals are not filtered) — a false
 * positive merely keeps a module on the legacy lane.
 */
export function methodBodyRefsShadowedOuterLocal(method: ts.FunctionLikeDeclaration): boolean {
  if (!method.body) return false;
  // Enclosing function-like chain (class/obj-literal at module scope → none).
  const enclosing: ts.FunctionLikeDeclaration[] = [];
  let sf: ts.SourceFile | undefined;
  let p: ts.Node | undefined = method.parent;
  while (p) {
    if (ts.isSourceFile(p)) {
      sf = p;
      break;
    }
    if (
      ts.isFunctionDeclaration(p) ||
      ts.isFunctionExpression(p) ||
      ts.isArrowFunction(p) ||
      ts.isMethodDeclaration(p) ||
      ts.isConstructorDeclaration(p) ||
      ts.isGetAccessorDeclaration(p) ||
      ts.isSetAccessorDeclaration(p)
    ) {
      enclosing.push(p);
    }
    p = p.parent;
  }
  if (sf === undefined || enclosing.length === 0) return false;

  const addBindingNames = (name: ts.BindingName, out: Set<string>): void => {
    if (ts.isIdentifier(name)) {
      out.add(name.text);
      return;
    }
    for (const el of name.elements) {
      if (ts.isBindingElement(el)) addBindingNames(el.name, out);
    }
  };

  // Module-scope declared names.
  const moduleNames = new Set<string>();
  for (const st of sf.statements) {
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) addBindingNames(d.name, moduleNames);
    } else if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name) {
      moduleNames.add(st.name.text);
    }
  }
  if (moduleNames.size === 0) return false;

  // Names declared anywhere within the enclosing functions (over-approx —
  // includes nested scopes; excludes the method's own subtree).
  const outerDecls = new Set<string>();
  for (const fn of enclosing) {
    for (const prm of fn.parameters) addBindingNames(prm.name, outerDecls);
    const walk = (n: ts.Node): void => {
      if (n === method) return;
      if (ts.isVariableDeclaration(n)) addBindingNames(n.name, outerDecls);
      else if ((ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n)) && n.name) outerDecls.add(n.name.text);
      forEachChild(n, walk);
    };
    if (fn.body) walk(fn.body);
  }
  if (outerDecls.size === 0) return false;

  // Free-identifier scan of the method body (property names skipped).
  let found = false;
  const scan = (n: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(n)) {
      const par = n.parent;
      const isPropertyName =
        (ts.isPropertyAccessExpression(par) && par.name === n) ||
        (ts.isPropertyAssignment(par) && par.name === n) ||
        ((ts.isMethodDeclaration(par) || ts.isGetAccessorDeclaration(par) || ts.isSetAccessorDeclaration(par)) &&
          par.name === n);
      if (!isPropertyName && outerDecls.has(n.text) && moduleNames.has(n.text)) {
        found = true;
        return;
      }
    }
    forEachChild(n, scan);
  };
  scan(method.body);
  return found;
}

/**
 * (#3132 S2) True when the body references `super` (only) from its own scope —
 * same descend/stop rules as {@link genBodyReferencesThis}, but `this` reads do
 * NOT count. The async-gen METHOD drive threads the receiver (`this`, the
 * synthetic param 0) into the frame and restores it by name in the resume fn,
 * so a `this`-reading method body IS drivable; `super` needs a home-object
 * binding the resume fn does not carry, so it stays legacy (correct-or-legacy).
 */
export function genBodyReferencesSuper(node: ts.Node): boolean {
  if (node.kind === ts.SyntaxKind.SuperKeyword) return true;
  if (
    ts.isFunctionExpression(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isClassLike(node)
  ) {
    return false; // own `super` binding — not the generator method's
  }
  let found = false;
  forEachChild(node, (child) => {
    if (!found && genBodyReferencesSuper(child)) found = true;
  });
  return found;
}

/**
 * (#3046) True when the function-expression / arrow `fn` references `this`
 * from ITS OWN scope: descend through nested arrows (they inherit `fn`'s
 * `this`), but stop at nested function expressions / declarations / methods /
 * classes (they rebind `this`). Used to gate the reviver `this`-forwarding so
 * a reviver that never touches `this` keeps the unchanged `__make_callback`
 * path (zero-risk), and only `this`-using revivers take the getter-callback
 * bridge.
 */
export function functionBodyReferencesThis(fn: ts.ArrowFunction | ts.FunctionExpression): boolean {
  const walk = (node: ts.Node): boolean => {
    if (node.kind === ts.SyntaxKind.ThisKeyword) return true;
    if (
      ts.isFunctionExpression(node) ||
      ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isAccessor(node) ||
      ts.isClassLike(node)
    ) {
      return false; // own `this` binding — does not inherit fn's receiver
    }
    let found = false;
    forEachChild(node, (child) => {
      if (!found && walk(child)) found = true;
    });
    return found;
  };
  // Inspect the body only (not `fn` itself, which is a function boundary).
  return walk(fn.body);
}

/**
 * (#3270 dedup) Build the single capture-struct field definition for one
 * capture. A mutable, not-yet-boxed capture becomes a `(ref null <refcell>)`
 * field (registering the ref-cell type on first sight); every other capture —
 * immutable, or mutable-and-already-boxed (whose type IS the ref cell) — keeps
 * its own type. All capture fields are immutable (the box, not the slot, is
 * mutated). Shared by the arrow-closure and arrow-callback capture-struct
 * builders, which open-coded this identical per-capture branch.
 */
export function buildCaptureFieldDef(
  ctx: CodegenContext,
  cap: { name: string; type: ValType; mutable: boolean; alreadyBoxed: boolean },
): FieldDef {
  if (cap.mutable && !cap.alreadyBoxed) {
    // First time boxing: create ref cell type for the capture value type
    const refCellTypeIdx = getOrRegisterRefCellType(ctx, cap.type);
    return { name: cap.name, type: { kind: "ref_null" as const, typeIdx: refCellTypeIdx }, mutable: false };
  }
  // Immutable, or already boxed (capture's type IS the ref cell type already).
  return { name: cap.name, type: cap.type, mutable: false };
}

/**
 * (#3270 dedup) Ensure the `__extern_is_undefined` late import is registered and
 * flush any resulting funcIdx shift onto the live `fctx.body`, returning its
 * index (or `undefined` in standalone mode where the import is unavailable).
 * The flush must land while `fctx.body` is authoritative — before any body swap
 * detaches the initializer instructions.
 */
function ensureExternIsUndefinedImport(ctx: CodegenContext, fctx: FunctionContext): number | undefined {
  const idx = ensureLateImportShared(ctx, "__extern_is_undefined", [{ kind: "externref" }], [{ kind: "i32" }]);
  flushLateImportShiftsShared(ctx, fctx);
  return idx;
}

/**
 * (#3270 dedup) Assuming the candidate value is already on the stack, emit the
 * "is this externref `undefined`?" test: call `__extern_is_undefined` when it is
 * available, else fall back to `ref.is_null` (imprecise in standalone — treats
 * `null` as `undefined`). Leaves an i32 on the stack. Shared by the object- and
 * array-binding default-initializer arms.
 */
function emitExternIsUndefinedCheck(ctx: CodegenContext, fctx: FunctionContext): void {
  const isUndefIdx = ensureExternIsUndefinedImport(ctx, fctx);
  if (isUndefIdx !== undefined) {
    fctx.body.push({ op: "call", funcIdx: isUndefIdx });
  } else {
    fctx.body.push({ op: "ref.is_null" });
  }
}

export function compileArrowFunction(
  ctx: CodegenContext,
  fctx: FunctionContext,
  arrow: ts.ArrowFunction | ts.FunctionExpression,
): ValType | null {
  // If used as callback argument to a host call, use the __make_callback path
  if (isHostCallbackArgument(arrow, ctx)) {
    const deferredInvocation = isDeferredCallbackArgument(arrow, ctx);
    // (#3046) A JSON.parse reviver that reads `this` must have the holder
    // forwarded as its receiver (§25.5.1.1). Route it through the
    // `this`-forwarding `__make_getter_callback` bridge.
    const needsThis = isJsonReviverArgument(arrow) && functionBodyReferencesThis(arrow);
    return compileArrowAsCallback(ctx, fctx, arrow, { deferredInvocation, needsThis });
  }
  // Otherwise, compile as a first-class closure value
  return compileArrowAsClosure(ctx, fctx, arrow);
}

/**
 * (#3683 S2) Options for {@link compileLiftedClosureBody} — every value
 * `compileArrowAsClosure` computes in its phases 1-4 that the body-compilation
 * core consumes. Extracting this core is the prerequisite for typed-`this`
 * monomorphization: the SAME arrow AST must be compilable TWICE (once for the
 * generic `__current_this` body, once for the typed twin), and the ~200 lines
 * of coupled machinery below (capture/TDZ materialization, named-expr self
 * bindings, savedFunc swap + liveBodies tracking, param defaults/destructuring,
 * `arguments` vec, string-builder detection, var/let-const hoisting,
 * generator/async lanes) were not reusable in place.
 */
export interface LiftedClosureBodyOptions {
  /** Wasm function name for the lifted body (the twin uses a distinct name). */
  closureName: string;
  captures: ArrowClosureCapture[];
  selfBindingName: string | undefined;
  arrowParams: ValType[];
  /** Mutated in place by the concise-body return-type repair (see below). */
  closureResults: ValType[];
  liftedParams: ValType[];
  structTypeIdx: number;
  liftedSelfTypeIdx: number;
  liftedFuncTypeIdx: number;
  closureReturnType: ValType | null;
  isGenerator: boolean;
  isAsync: boolean;
  asyncDecision: ReturnType<typeof planAsyncClosureActivation>;
  isNamedFuncExpr: boolean;
  /**
   * (#3683 S2) When set, compile this body as the TYPED TWIN of an admitted
   * fnctor prototype method: param 0 is the `(ref $__fnctor_F)` receiver (see
   * `emitTypedThisPrologue`), and `fctx.typedThisStructIdx` /
   * `typedThisLocalIdx` let the property-read / assignment / compound-update
   * lowerings emit bare `struct.get`/`struct.set` against it instead of the
   * `__get_member_*` / `__set_member_*` dispatcher calls.
   */
  typedThis?: { fnctorStructTypeIdx: number; structName: string };
}

/** (#3683 S2) What {@link compileLiftedClosureBody} produces / may have repaired. */
export interface LiftedClosureBodyResult {
  liftedFctx: FunctionContext;
  /** May differ from `opts.closureReturnType` (concise-body f64 repair). */
  closureReturnType: ValType | null;
  /** May differ from `opts.liftedFuncTypeIdx` (same repair). */
  liftedFuncTypeIdx: number;
}

/**
 * (#3683 S2) Compile the body of ONE lifted closure function. Extracted
 * verbatim from `compileArrowAsClosure` phase 5 so the same arrow AST can be
 * compiled more than once; the generic call site passes no `typedThis` and is
 * byte-identical to the pre-extraction emission.
 *
 * Does NOT mint/register the wasm function, emit the construction site, or
 * register closure binding info — those stay with the caller (they must happen
 * exactly ONCE per arrow even when two bodies are emitted).
 */
export function compileLiftedClosureBody(
  ctx: CodegenContext,
  fctx: FunctionContext,
  arrow: ts.ArrowFunction | ts.FunctionExpression,
  opts: LiftedClosureBodyOptions,
): LiftedClosureBodyResult {
  const body = recordClosureBody(ctx, "compileLiftedClosureBody", opts.closureName, arrow);
  const {
    closureName,
    captures,
    selfBindingName,
    arrowParams,
    closureResults,
    liftedParams,
    structTypeIdx,
    liftedSelfTypeIdx,
    isGenerator,
    isAsync,
    asyncDecision,
    isNamedFuncExpr,
  } = opts;
  let { closureReturnType, liftedFuncTypeIdx } = opts;
  // 5. Build the lifted function body
  // Shared-wrapper lifted functions receive the canonical wrapper ROOT,
  // regardless of their per-signature allocation wrapper. Captured bodies
  // downcast that root to their concrete environment subtype. Named function
  // expressions retain their private nullable self type for var hoisting.
  const usesWrapperFuncType = liftedSelfTypeIdx !== structTypeIdx;
  const selfParamKind = isNamedFuncExpr ? ("ref_null" as const) : ("ref" as const);
  const selfTypeIdx = liftedSelfTypeIdx;
  // (#3683 S3) A twin's param 0 carries the RECEIVER, not the closure env. See
  // `emitTypedThisPrologue` for the full argument; the short version is that
  // admission already requires zero captures / no self binding / not a named
  // function expression, so nothing in an admitted body can read `__self` — and
  // handing the receiver in as a real parameter is what lets a devirtualized
  // caller invoke the twin without first materializing the closure singleton.
  const twinSelfTypeIdx =
    opts.typedThis && directCallLoweringEnabled() ? opts.typedThis.fnctorStructTypeIdx : undefined;
  const liftedFctx: FunctionContext = {
    name: closureName,
    params: [
      twinSelfTypeIdx !== undefined
        ? { name: "__self", type: { kind: "ref" as const, typeIdx: twinSelfTypeIdx } }
        : { name: "__self", type: { kind: selfParamKind, typeIdx: selfTypeIdx } },
      // (#3359) Skip a TS `this` param — type-level only, never a runtime arg.
      ...runtimeParameters(arrow).map((p, i) => ({
        name: ts.isIdentifier(p.name) ? p.name.text : `__param${i}`,
        type: arrowParams[i] ?? { kind: "f64" as const },
      })),
    ],
    locals: [],
    localMap: new Map(),
    returnType: closureReturnType,
    body: [],
    blockDepth: 0,
    breakStack: [],
    continueStack: [],
    labelMap: new Map(),
    savedBodies: [],
    enclosingClassName: fctx.enclosingClassName ?? resolveEnclosingClassName(fctx),
    // (#1395) Propagate static-context flag so `this` inside an arrow
    // captured from a static initializer / static method resolves to the
    // class-object singleton rather than `undefined`.
    isStaticContext: fctx.isStaticContext,
    isGenerator,
    deferredDynamicImportTrap: !isAsync && !isGenerator,
    // (#1636-S1) This lifted closure body can be dispatched from the host via
    // `__call_fn_method_N` (e.g. as a `JSON.stringify` replacer / `toJSON`),
    // which installs the host receiver into `__current_this`. Allow `this`
    // (with no other binding) to read that global. Named functions / methods
    // are NOT lifted here and keep `undefined`/globalObject `this`.
    readsCurrentThis: true,
    // (#2681/#2686 A3) When this lifted closure is a fnctor PROTOTYPE method of an
    // approved-for-reconstruction fnctor (`F.prototype.m = fn` / aliased `var pp =
    // F.prototype; pp.m = fn`), pin its `this` receiver to `__fnctor_F` so the
    // dynamic `this.<field>` read dispatch (property-access.ts) routes through the
    // finalize-filled `__get_member_<name>` struct dispatcher instead of the
    // host-proxy `__extern_get` (whose externref identity diverges from the stored
    // native struct → the #2681/#2686 throw).
    thisStructName: resolveLiftedMethodThisStruct(ctx, arrow),
  };
  const reachesDirectEval = functionMayReachDirectEval(arrow, ctx.oracle);
  if (reachesDirectEval) {
    liftedFctx.directEvalBindingNames = collectDirectEvalBindingNames(arrow);
    liftedFctx.directEvalActivationBindingNames = collectDirectEvalActivationBindingNames(arrow);
    liftedFctx.directEvalOuterBindingNames = new Set<string>();
    for (const capture of captures) {
      liftedFctx.directEvalBindingNames.add(capture.name);
      liftedFctx.directEvalOuterBindingNames.add(capture.name);
    }
  }
  initializeFunctionPoisonPillContext(ctx, liftedFctx, arrow);

  // Track the body before capture/TDZ prologues so late imports can shift
  // their call indices before the saved-function swap exposes it (#1384).
  ctx.liveBodies.add(liftedFctx.body);

  for (let i = 0; i < liftedFctx.params.length; i++) {
    liftedFctx.localMap.set(liftedFctx.params[i]!.name, i);
  }
  // (#3683 S2/S3) Typed-`this` TWIN prologue. Runs FIRST so `typedThisLocalIdx`
  // is live for every subsequent statement. Since S3 this emits NO instructions
  // at all — the receiver arrives as param 0 — see typed-this.ts.
  if (opts.typedThis) {
    emitTypedThisPrologue(
      liftedFctx,
      opts.typedThis.structName,
      opts.typedThis.fnctorStructTypeIdx,
      twinSelfTypeIdx === undefined ? ensureCurrentThisGlobal(ctx) : undefined,
    );
  }

  // When using wrapper func types, __self is typed as the wrapper base struct —
  // cast it to the specific subtype to access capture fields.
  let selfLocalForCaptures = 0; // default: param 0 (__self)
  if (usesWrapperFuncType && captures.length > 0) {
    const castLocal = allocLocal(liftedFctx, "__self_cast", { kind: "ref", typeIdx: structTypeIdx });
    liftedFctx.body.push({ op: "local.get", index: 0 }); // __self (wrapper base type)
    liftedFctx.body.push({ op: "ref.cast", typeIdx: structTypeIdx });
    liftedFctx.body.push({ op: "local.set", index: castLocal });
    selfLocalForCaptures = castLocal;
  }
  // (#2865) Record the capture layout so the async drive lane's FRESH resume
  // FunctionContext can re-materialize these capture locals from the
  // frame-captured `__self` (the materialization below lands only in THIS
  // lifted body; a driven body compiles in the resume fn instead).
  const selfCaptureLayoutEntries: { name: string; fieldIdx: number; localType: ValType }[] = [];
  if (captures.length > 0) {
    liftedFctx.selfCaptureLayout = {
      selfParamName: "__self",
      structTypeIdx,
      castToTypeIdx: usesWrapperFuncType ? structTypeIdx : null,
      entries: selfCaptureLayoutEntries,
    };
  }
  for (let i = 0; i < captures.length; i++) {
    const cap = captures[i]!;
    if (cap.mutable) {
      // Mutable capture: store the ref cell reference itself.
      // If already boxed, cap.type IS the ref cell type — extract the existing
      // ref cell type index instead of creating a new wrapper.
      let refCellTypeIdx: number;
      let valType: ValType;
      if (cap.alreadyBoxed && (cap.type.kind === "ref" || cap.type.kind === "ref_null")) {
        // Already boxed: the field stores the ref cell directly
        refCellTypeIdx = (cap.type as { typeIdx: number }).typeIdx;
        // Look up the original value type from the outer scope's boxed capture
        // info; when absent (#3328 — the lifted body compiles BEFORE the
        // construct site populates fctx.boxedCaptures), fall back to the ref
        // cell's own field-0 type, which IS the value type. The old blind f64
        // default retyped captured strings as numbers, so `log += 'y'` inside
        // a capturing toString/valueOf compiled to f64.add + a null-ref
        // placeholder that trapped on first call.
        const outerBoxed = fctx.boxedCaptures?.get(cap.name);
        valType = outerBoxed?.valType ?? refCellValueType(ctx, refCellTypeIdx) ?? { kind: "f64" };
      } else {
        refCellTypeIdx = getOrRegisterRefCellType(ctx, cap.type);
        valType = cap.type;
      }
      const refCellType: ValType = { kind: "ref_null", typeIdx: refCellTypeIdx };
      const localIdx = allocLocal(liftedFctx, cap.name, refCellType);
      selfCaptureLayoutEntries.push({
        name: cap.name,
        fieldIdx: CLOSURE_CAPTURE_FIELD_BASE + i,
        localType: refCellType,
      });
      liftedFctx.body.push({ op: "local.get", index: selfLocalForCaptures });
      liftedFctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx: CLOSURE_CAPTURE_FIELD_BASE + i });
      liftedFctx.body.push({ op: "local.set", index: localIdx });
      // Register as boxed so identifier read/write uses struct.get/set
      if (!liftedFctx.boxedCaptures) liftedFctx.boxedCaptures = new Map();
      liftedFctx.boxedCaptures.set(cap.name, { refCellTypeIdx, valType });
    } else if (cap.alreadyBoxed && (cap.type.kind === "ref" || cap.type.kind === "ref_null")) {
      // Non-mutable capture of an already-boxed variable: the struct field holds
      // the ref cell.  Register it in boxedCaptures so the body code dereferences
      // through struct.get on the ref cell instead of using the raw ref value.
      const refCellTypeIdx = (cap.type as { typeIdx: number }).typeIdx;
      const outerBoxed = fctx.boxedCaptures?.get(cap.name);
      // (#3328) Cell field-0 type as the fallback — see the mutable arm above.
      const valType = outerBoxed?.valType ?? refCellValueType(ctx, refCellTypeIdx) ?? { kind: "f64" as const };
      const refCellType: ValType = { kind: "ref_null", typeIdx: refCellTypeIdx };
      const localIdx = allocLocal(liftedFctx, cap.name, refCellType);
      selfCaptureLayoutEntries.push({
        name: cap.name,
        fieldIdx: CLOSURE_CAPTURE_FIELD_BASE + i,
        localType: refCellType,
      });
      liftedFctx.body.push({ op: "local.get", index: selfLocalForCaptures });
      liftedFctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx: CLOSURE_CAPTURE_FIELD_BASE + i });
      liftedFctx.body.push({ op: "local.set", index: localIdx });
      if (!liftedFctx.boxedCaptures) liftedFctx.boxedCaptures = new Map();
      liftedFctx.boxedCaptures.set(cap.name, { refCellTypeIdx, valType });
    } else {
      const localIdx = allocLocal(liftedFctx, cap.name, cap.type);
      selfCaptureLayoutEntries.push({ name: cap.name, fieldIdx: CLOSURE_CAPTURE_FIELD_BASE + i, localType: cap.type });
      liftedFctx.body.push({ op: "local.get", index: selfLocalForCaptures });
      liftedFctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx: CLOSURE_CAPTURE_FIELD_BASE + i });
      liftedFctx.body.push({ op: "local.set", index: localIdx });
      if (cap.name === RUNTIME_EVAL_STATE_POOL_CAPTURE_NAME) {
        liftedFctx.directEvalActivationStatePoolLocal = localIdx;
        liftedFctx.directEvalRefCellTypeIdx = fctx.directEvalRefCellTypeIdx;
        liftedFctx.directEvalOuterBindingNames = new Set(
          captures
            .filter((capture) => capture.name !== RUNTIME_EVAL_STATE_POOL_CAPTURE_NAME)
            .map((capture) => capture.name),
        );
      }
    }
  }
  rehydrateWithEnvironmentScopes(fctx, liftedFctx, closureName, arrowOwnLocals(arrow));
  // The capture bindings do not exist in localMap until the prologue above
  // allocates and fills them. Freeze their lifted-frame slots now, before body
  // declarations can shadow the names. Recording them immediately after the
  // parameter setup produced an empty map, so a transitive sibling call from a
  // closure reused the declaring frame's outerLocalIdx (ReactDOM read local
  // 350 from a 46-slot closure frame).
  recordCaptureSlots(
    liftedFctx,
    captures.map((capture) => capture.name),
  );
  // #1177: For TDZ-flagged captures, also extract the boxed flag ref into a
  // local in the lifted fctx and register it in `boxedTdzFlags` +
  // `tdzFlagLocals`. This makes existing TDZ-check call sites (calls.ts,
  // identifiers.ts) automatically route through `struct.get` on the ref cell.
  // Field-layout invariant: TDZ flag fields come AFTER all value fields, i.e.
  // fieldIdx = CLOSURE_CAPTURE_FIELD_BASE + captures.length + tdzCaptureIndex.
  {
    const tdzFlaggedCapturesForPrologue = captures.filter((c) => c.hasTdzFlag);
    if (tdzFlaggedCapturesForPrologue.length > 0) {
      const i32RefCellTypeIdx = getOrRegisterRefCellType(ctx, { kind: "i32" });
      const flagRefType: ValType = { kind: "ref_null", typeIdx: i32RefCellTypeIdx };
      for (let ti = 0; ti < tdzFlaggedCapturesForPrologue.length; ti++) {
        const cap = tdzFlaggedCapturesForPrologue[ti]!;
        const tdzFieldIdx = CLOSURE_CAPTURE_FIELD_BASE + captures.length + ti;
        const flagBoxLocal = allocLocal(liftedFctx, `__tdz_box_${cap.name}`, flagRefType);
        liftedFctx.body.push({ op: "local.get", index: selfLocalForCaptures });
        liftedFctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx: tdzFieldIdx });
        liftedFctx.body.push({ op: "local.set", index: flagBoxLocal });
        if (!liftedFctx.boxedTdzFlags) liftedFctx.boxedTdzFlags = new Map();
        liftedFctx.boxedTdzFlags.set(cap.name, { refCellTypeIdx: i32RefCellTypeIdx, localIdx: flagBoxLocal });
        // Re-aim tdzFlagLocals so existing TDZ-check helpers detect the flag.
        // (boxedTdzFlags drives the actual struct.get/set routing.)
        if (!liftedFctx.tdzFlagLocals) liftedFctx.tdzFlagLocals = new Map();
        liftedFctx.tdzFlagLocals.set(cap.name, flagBoxLocal);
      }
    }
  }

  // For named function expressions, register the name in the lifted
  // function's local scope so recursive calls resolve to __self (the
  // closure struct).  Also register in closureMap so the call-site
  // compiler emits call_ref instead of a direct call.
  let funcExprName: string | undefined;
  if (ts.isFunctionExpression(arrow) && arrow.name) {
    funcExprName = arrow.name.text;
    // Map the name to the __self param (index 0) inside the lifted body
    liftedFctx.localMap.set(funcExprName, 0);
    // The function name binding is read-only (assignments are silently ignored)
    if (!liftedFctx.readOnlyBindings) liftedFctx.readOnlyBindings = new Set();
    liftedFctx.readOnlyBindings.add(funcExprName);
  }

  // (#2118) Self-recursive const/let arrow binding: map the binding name to the
  // __self param so recursive `f(...)` calls inside the body dispatch through
  // the closure's own struct via call_ref (mirrors the named-funcexpr path).
  // The name is NOT registered as read-only — unlike a funcexpr's own name, a
  // `let f` binding may legitimately be reassigned in the outer scope; inside
  // the closure body, however, the reference is the recursive self.
  if (selfBindingName !== undefined && !liftedFctx.localMap.has(selfBindingName)) {
    liftedFctx.localMap.set(selfBindingName, 0);
  }

  const savedFunc = ctx.currentFunc;
  if (savedFunc) ctx.parentBodiesStack.push(savedFunc.body);
  if (savedFunc) ctx.funcStack.push(savedFunc);
  ctx.currentFunc = liftedFctx;

  // Temporarily register closure info for named function expressions so
  // recursive calls inside the body are compiled as closure calls.
  const selfHasRestParam = runtimeParameters(arrow).some((param) => param.dotDotDotToken !== undefined);
  const closureInfoForSelf: ClosureInfo = {
    structTypeIdx,
    funcTypeIdx: liftedFuncTypeIdx,
    returnType: closureReturnType,
    paramTypes: arrowParams,
    hasRestParam: selfHasRestParam,
  };
  if (funcExprName) {
    ctx.closureMap.set(funcExprName, closureInfoForSelf);
  }

  // (#2118) Register the self-recursive const/let arrow binding so recursive
  // calls compile as closure calls dispatched through __self. The struct.get
  // that fetches the funcref runs against __self's *actual* param type
  // (`selfTypeIdx`: the canonical wrapper root for shared wrappers, or the
  // private struct for named function expressions), not necessarily the
  // concrete allocation subtype. Field 0 is available on that root, and the
  // lifted func type still drives call_ref.
  let savedSelfBindingClosureInfo: ClosureInfo | undefined;
  let hadSavedSelfBindingClosureInfo = false;
  if (selfBindingName !== undefined && selfBindingName !== funcExprName) {
    hadSavedSelfBindingClosureInfo = ctx.closureMap.has(selfBindingName);
    savedSelfBindingClosureInfo = ctx.closureMap.get(selfBindingName);
    ctx.closureMap.set(selfBindingName, {
      structTypeIdx: selfTypeIdx,
      funcTypeIdx: liftedFuncTypeIdx,
      returnType: closureReturnType,
      paramTypes: arrowParams,
      hasRestParam: selfHasRestParam,
    });
  }

  // Emit default-value initialization for simple params with defaults
  emitArrowParamDefaults(ctx, liftedFctx, arrow, 1 /* skip __self */);

  // Destructuring initialization for binding-pattern params — see emitClosureParamDestructuring.
  emitClosureParamDestructuring(ctx, liftedFctx, arrow, arrowParams);

  // Set up `arguments` object for function expressions (not arrow functions).
  // Arrow functions don't have their own `arguments` binding in JS.
  if (ts.isFunctionExpression(arrow) && ts.isBlock(body) && needsImplicitArgumentsObject(arrow, reachesDirectEval)) {
    // Ensure __box_number is available for boxing numeric params
    const hasNumericParam = arrowParams.some((pt) => pt.kind === "f64" || pt.kind === "i32");
    if (hasNumericParam) {
      ensureLateImportShared(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
      flushLateImportShiftsShared(ctx, liftedFctx);
    }

    const elemType: ValType = { kind: "externref" };
    const vti = getOrRegisterVecType(ctx, "externref", elemType);
    const ati = getArrTypeIdxFromVec(ctx, vti);
    const vecRef: ValType = { kind: "ref", typeIdx: vti };
    const argsLocal = allocLocal(liftedFctx, "arguments", vecRef);
    const arrTmp = allocLocal(liftedFctx, "__args_arr_tmp", { kind: "ref", typeIdx: ati });

    // (#4491) §10.2.11 step 22.a — a non-strict function expression with a simple
    // parameter list gets a MAPPED arguments object, exactly like the declaration
    // form. The reverse sync unboxes into an f64/i32 param, so `__unbox_number`
    // must exist before the mapped emitters look it up.
    if (hasNumericParam) {
      ensureLateImportShared(ctx, "__unbox_number", [{ kind: "externref" }], [{ kind: "f64" }]);
      flushLateImportShiftsShared(ctx, liftedFctx);
    }
    // `compileFunctionBody` has installed this for DECLARATIONS since #849; the
    // lifted expression form built the identical vec and never did, so
    // `(function (a) { arguments[0] = 1; })(0)` left `a` untouched while
    // `function f(a) { … }` updated it. Every mapped emitter keys off
    // `mappedArgsInfo`, so this is what turns them on for the expression form.
    const argsParams = runtimeParameters(arrow);
    if (
      arrowParams.length > 0 &&
      isSimpleParameterList(argsParams) &&
      !isStrictFunction(arrow, ctx.inferModuleStrictArguments)
    ) {
      liftedFctx.mappedArgsInfo = {
        argsLocalIdx: argsLocal,
        arrTypeIdx: ati,
        vecTypeIdx: vti,
        paramCount: arrowParams.length,
        paramOffset: 1, // lifted closures carry __self at local 0
        paramTypes: arrowParams.slice(),
      };
      // (#2676) Keyed by the declaration so a `delete args[i]` in a nested
      // strict closure can resolve an aliased `arguments` back to here.
      ctx.mappedArgsInfoByFunc.set(arrow, liftedFctx.mappedArgsInfo);
    }

    // (#779e) Build the arguments vec via the shared extras-aware helper so the
    // closure sees the TRUE call-site argument count (from __argc/__extras_argv
    // set by the closure call site, #1511) — not just its declared arity.
    // paramOffset is 1 because lifted closures carry __self at local index 0.
    emitArgumentsVecBody(ctx, liftedFctx, arrowParams, 1, {
      vecTypeIdx: vti,
      arrTypeIdx: ati,
      argsLocalIdx: argsLocal,
      arrTmpIdx: arrTmp,
    });

    // (#4243) §10.6 step 13.a — `callee` on a non-strict arguments object.
    seedLiftedClosureArgumentsCallee(ctx, liftedFctx, arrow, argsLocal);
  }

  let conciseBodyHasValue = false;

  // #1210: detect string-builder patterns BEFORE hoisting so the hoist
  // pass can skip pre-allocating the matched binding's local.
  if (ts.isBlock(body) && ctx.nativeStrings && ctx.anyStrTypeIdx >= 0) {
    const presize = new Map<ts.VariableDeclaration, StringBuilderPresizeInfo>();
    const builders = detectStringBuilders(ctx, body, presize);
    if (builders.size > 0) liftedFctx.pendingStringBuilders = builders;
    if (presize.size > 0) liftedFctx.stringBuilderPresize = presize; // #1761
  }

  // Pre-hoist function-scoped `var` declarations into the closure's localMap
  // (#1745). Regular functions run this in function-body.ts; closures/arrows
  // previously skipped it, so a `var x` inside a closure body that collided
  // with a same-named *module global* (declared a different type — e.g. a
  // top-level numeric `var i` vs. an array-holding `var i` inside the closure)
  // fell through `hasLocalShadow` to the global, emitting a `global.set`/`get`
  // whose value type did not match the global's declared type → invalid Wasm
  // ("global.set[0] expected type f64, found if of (ref null 3)" in acorn's
  // __closure_37). hoistVarDecl allocates a function-local that shadows the
  // module global per ECMA-262 §10.2.10. Must run BEFORE the let/const hoist
  // and before any statement compiles so every read/write of the var binds to
  // the local. The walker does not cross nested function scope boundaries, so
  // captured free variables are untouched.
  if (ts.isBlock(body)) {
    hoistVarDeclarations(ctx, liftedFctx, body.statements);
  }

  // Pre-hoist let/const with TDZ flags for the closure body so that
  // accesses before the declaration site throw ReferenceError (#790).
  // Async/generator state machines own their frame initialization. Ordinary
  // closure hoisting before that transform corrupts suspended-state layout.
  prepareLiftedFrameDeclarations(ctx, liftedFctx, body, true, !asyncDecision && !isGenerator);

  // (#3164) Native generator FUNCTION EXPRESSION (standalone/wasi). When the
  // extended candidate gate admits the fn-expr (zero/identifier params, no
  // `this`/`arguments`/self-name/capture — the same gate
  // `sourceNeedsGeneratorHostImports` consulted, so the `__gen_*` host imports
  // were NOT registered for it), register it under the lifted closure name with
  // the `__self` param threaded as a leading synthetic capture: the state
  // struct's param fields then align 1:1 with the lifted wasm params
  // (`local.get 0..n` in the factory), and the resume prelude rehydrates the
  // user params by name. The closure ABI is UNCHANGED (externref return) — the
  // factory's `(ref $GenState)` is widened via `extern.convert_any`, and every
  // consumer dispatches dynamically: `.next()/.return()/.throw()` through the
  // open anyref dispatch (`tryCompileNativeGeneratorMethodCall`), for-of /
  // destructuring / spread through the `__iterator` runtime's GENSTATE arm
  // (iterator-native.ts, filled at finalize).
  let nativeGenExprInfo: NativeGeneratorInfo | null = null;
  if (
    isGenerator &&
    !isAsync &&
    (ctx.standalone || ctx.wasi) &&
    ts.isFunctionExpression(arrow) &&
    ts.isBlock(body) &&
    isNativeGeneratorCandidate(ctx, arrow)
  ) {
    nativeGenExprInfo = registerNativeGenerator(
      ctx,
      arrow,
      closureName,
      [{ kind: selfParamKind, typeIdx: selfTypeIdx }, ...arrowParams],
      /* synthesizedThis */ false,
      [{ name: "__self" }],
    );
    // (#3302) CAPTURING fn-expr generator: hand the resume function the
    // `__self` capture-struct rehydration recipe. The value-capture entries
    // come from the prologue-recorded `selfCaptureLayout` (fields 1..N of the
    // closure struct, exactly what the lifted body materialized above); the
    // TDZ flag boxes follow at fields N+1..N+K (the #1177 prologue
    // invariant). `boxedCaptures`/`boxedTdzFlags` snapshots re-apply the same
    // cell registrations to the resume fctx so reads/writes/TDZ checks deref
    // the SHARED cells — write-through visibility to the enclosing frame.
    if (nativeGenExprInfo && captures.length > 0 && liftedFctx.selfCaptureLayout) {
      const tdzFlaggedForGen = captures.filter((c) => c.hasTdzFlag);
      const i32CellForGen = tdzFlaggedForGen.length > 0 ? getOrRegisterRefCellType(ctx, { kind: "i32" }) : -1;
      nativeGenExprInfo.selfCaptureRehydration = {
        selfParamName: "__self",
        structTypeIdx: liftedFctx.selfCaptureLayout.structTypeIdx,
        castToTypeIdx: liftedFctx.selfCaptureLayout.castToTypeIdx,
        entries: liftedFctx.selfCaptureLayout.entries,
        boxedCaptures: Array.from(liftedFctx.boxedCaptures ?? []).map(([name, b]) => ({
          name,
          refCellTypeIdx: b.refCellTypeIdx,
          valType: b.valType,
        })),
        tdzFlags: tdzFlaggedForGen.map((c, ti) => ({
          name: c.name,
          fieldIdx: CLOSURE_CAPTURE_FIELD_BASE + captures.length + ti,
          refCellTypeIdx: i32CellForGen,
        })),
      };
    }
  }

  if (
    isGenerator &&
    isAsync &&
    ts.isBlock(body) &&
    (liftedFctx.boxedTdzFlags === undefined || liftedFctx.boxedTdzFlags.size === 0) &&
    isAsyncGenDriveCandidate(ctx, arrow)
  ) {
    // (#2865) Async-generator function EXPRESSION producer (`const f = async
    // function* () {...}` — the test262 forbidden-ext fn-expr family, which
    // previously compiled to a null-returning shape under standalone). Same
    // interception as the top-level / nested-declaration paths: build the lazy
    // `$AsyncFrame` carrier + the per-gen `__async_gen_next_<name>` driver on
    // the async-frame CFG machine. Capture cells (leading params of the lifted
    // closure) ride into frame param fields; `boxedCaptures` is threaded onto
    // the resume fn. TDZ-flagged captures store PARAM indices in
    // `boxedTdzFlags` (wrong in the resume fn's local layout) → legacy path.
    emitAsyncGenerator(ctx, liftedFctx, arrow);
    // (#3683 S2) The trailing `ts.isFunctionExpression(arrow)` below is IMPLIED
    // by a non-null `nativeGenExprInfo` (only the fn-expr arm above registers
    // it); it is restated purely so TypeScript narrows `arrow` for
    // `compileNativeGeneratorFunction`. Pre-extraction that narrowing came for
    // free from the aliased-condition `const isGenerator =
    // ts.isFunctionExpression(arrow) && …`, which no longer reaches this scope
    // now that `isGenerator` arrives via `opts`.
  } else if (isGenerator && ts.isBlock(body) && nativeGenExprInfo && ts.isFunctionExpression(arrow)) {
    // (#3164) Emit the native state-struct factory (mirrors the class-method /
    // object-literal wiring, #2571/#2581): construct `$GenState_<closure>` from
    // the lifted wasm params (param 0 = `__self`, threaded as a leading
    // synthetic capture; user params follow), then widen to the closure's
    // externref return. The body itself compiles once, inside the resume
    // function (`ensureNativeGeneratorResumeFunction`). ZERO host imports —
    // no `__gen_create_buffer` / `__create_generator` / `__get_caught_exception`.
    compileNativeGeneratorFunction(ctx, liftedFctx, arrow, nativeGenExprInfo);
    liftedFctx.body.push({ op: "extern.convert_any" });
    conciseBodyHasValue = true;
  } else if (isGenerator && ts.isBlock(body)) {
    // Generator function expression: eagerly evaluate body, collect yields
    // into a buffer, then wrap with __create_generator.
    // The body is wrapped in try/catch so that exceptions thrown before any yields
    // are captured as a "pending throw" and deferred to the first next() call,
    // matching lazy generator semantics (#928).
    //
    // (#3032 / #2141-S2) LAZY-FIRST-RESUME: for the zero-param non-async case
    // the eager sequence below is wrapped in an `if (global $__gen_eager_mode)`
    // — when the flag is 0 (default) the closure instead returns
    // `__create_generator(<self as externref>, null)`, a lazy host generator
    // holding this closure as a thunk; the host re-invokes it with the flag
    // set on the FIRST `next()` (see ensureGenEagerFlag). Wrapping the whole
    // sequence in one extra `if` level is branch-target-safe: every `br` the
    // body emits targets the inner `block`/`try` (generator `return` uses
    // generatorReturnDepth relative to that block), never a label outside the
    // wrap, and the function-level `return` op is depth-independent.
    // Lazy-ineligible: async (separate host machinery), declared params (the
    // thunk re-invocation via `__call_fn_0` cannot replay call-site args —
    // #3032 W2), `arguments` usage (zero-declared-param generators can still
    // observe call-site args through `arguments`; the deferred re-invocation
    // would see arity 0 — the gen-func-expr-args-trailing-comma cluster in PR
    // #2625's first merge_group cycle), and `this`/`super` usage (the
    // receiver is call-time state the deferred `__call_fn_0` re-invocation
    // cannot rebind — the `Array.prototype[Symbol.iterator] = function*() {
    // ... this[0] ... }` iter-val-array-prototype cluster, same cycle).
    // Receiver/args spilling is #3032 W2.
    const genLazyEligible =
      !isAsync &&
      runtimeParameters(arrow).length === 0 && // (#3359) a TS `this` param is not a runtime arg
      !(ts.isBlock(body) && closureBodyUsesArguments(body)) &&
      !genBodyReferencesThis(body);
    // (#3164) Defensive: in a no-JS-host target the eager-buffer path needs the
    // `__gen_*` host imports, which the pre-scan (`sourceNeedsGeneratorHostImports`)
    // skips when it classifies every generator as native. If this fn-expr was
    // admitted by the pre-scan but the emit-time registration bailed (a
    // candidate/plan desync), baking an undefined funcIdx would produce an
    // INVALID module — late-register the import bundle instead (idempotent,
    // shift-safe; the IR path does the same mid-emission).
    if ((ctx.standalone || ctx.wasi) && !ctx.funcMap.has("__gen_create_buffer")) {
      addGeneratorImports(ctx, { allowNoJsHost: true });
    }
    const genOuterBody = liftedFctx.body;
    const eagerSeq: Instr[] = [];
    if (genLazyEligible) liftedFctx.body = eagerSeq;
    const bufferLocal = allocLocal(liftedFctx, "__gen_buffer", { kind: "externref" });
    const pendingThrowLocal = allocLocal(liftedFctx, "__gen_pending_throw", { kind: "externref" });
    const createBufIdx = ctx.funcMap.get("__gen_create_buffer")!;
    liftedFctx.body.push({ op: "call", funcIdx: createBufIdx });
    liftedFctx.body.push({ op: "local.set", index: bufferLocal });
    liftedFctx.body.push({ op: "ref.null.extern" });
    liftedFctx.body.push({ op: "local.set", index: pendingThrowLocal });

    // Wrap body in a block so return can br out
    const bodyInstrs: Instr[] = [];
    const outerBody = liftedFctx.body;
    liftedFctx.body = bodyInstrs;

    liftedFctx.generatorReturnDepth = 0;
    liftedFctx.blockDepth++;
    for (let i = 0; i < liftedFctx.breakStack.length; i++) liftedFctx.breakStack[i]!++;
    for (let i = 0; i < liftedFctx.continueStack.length; i++) liftedFctx.continueStack[i]!++;

    for (const stmt of body.statements) {
      compileStatement(ctx, liftedFctx, stmt);
    }

    liftedFctx.blockDepth--;
    for (let i = 0; i < liftedFctx.breakStack.length; i++) liftedFctx.breakStack[i]!--;
    for (let i = 0; i < liftedFctx.continueStack.length; i++) liftedFctx.continueStack[i]!--;
    liftedFctx.generatorReturnDepth = undefined;

    liftedFctx.body = outerBody;

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
    liftedFctx.body.push(
      buildTargetTaggedTry(
        ctx,
        { kind: "empty" },
        [{ op: "block", blockType: { kind: "empty" }, body: bodyInstrs }],
        [{ tagIdx, body: catchBody }],
        catchAllBody,
      ),
    );

    // Return __create_generator or __create_async_generator depending on async flag
    const createGenName = isAsync ? "__create_async_generator" : "__create_generator";
    // (#2865) Record legacy-buffer async gens so the .next() dispatch keeps a host miss arm.
    if (createGenName === "__create_async_generator") ctx.asyncGenLegacyBufferEmitted = true;
    ctx.legacyGenBufferEmitted = true; // (#3132) sync OR async legacy buffer emitted
    const createGenIdx = ctx.funcMap.get(createGenName)!;
    liftedFctx.body.push({ op: "local.get", index: bufferLocal });
    liftedFctx.body.push({ op: "local.get", index: pendingThrowLocal });
    liftedFctx.body.push({ op: "call", funcIdx: createGenIdx });

    // (#3032) Wrap the eager sequence behind the eager-mode flag; default (0)
    // returns the LAZY thunk generator instead. The eager arm clears the flag
    // at its top so nested generator creations during the deferred body run
    // are themselves lazy again.
    if (genLazyEligible) {
      liftedFctx.body = genOuterBody;
      const flagGlobalIdx = ensureGenEagerFlag(ctx);
      liftedFctx.body.push({ op: "global.get", index: flagGlobalIdx });
      liftedFctx.body.push({
        op: "if",
        blockType: { kind: "val", type: { kind: "externref" } },
        then: [{ op: "i32.const", value: 0 }, { op: "global.set", index: flagGlobalIdx }, ...eagerSeq],
        else: [
          { op: "local.get", index: 0 },
          { op: "extern.convert_any" },
          { op: "ref.null.extern" },
          { op: "call", funcIdx: createGenIdx },
        ],
      });
    }
    conciseBodyHasValue = true; // generator return value is already on stack
  } else if (asyncDecision) {
    // (#2957 phase 2) Emit the async state machine instead of the normal body
    // loop. `closureReturnType` was already forced to `externref` above, so the
    // lifted func/struct type carries the Promise result — no post-hoc type
    // rewrite (unlike the declaration entry `maybeActivateAsync`). Handles both
    // block bodies (`async () => { return await P; }`) and the concise
    // single-tail-await (`async () => await P`, routed via the concise branch in
    // `splitBodyAtAwait`). The emitter leaves the result Promise + a `return` on
    // the body, so the default-return tail below is a no-op.
    emitAsyncClosureBody(ctx, liftedFctx, arrow, asyncDecision);
  } else if (ts.isBlock(body)) {
    for (const stmt of body.statements) {
      compileStatement(ctx, liftedFctx, stmt);
    }
  } else {
    const exprType = compileExpression(ctx, liftedFctx, body);
    if (exprType !== null && closureReturnType) {
      // Expression result is the return value - already on stack
      conciseBodyHasValue = true;

      // The actual expression type may differ from the declared return type
      // (e.g. TS infers `any`->externref but codegen produces f64 for arithmetic).
      // Coerce the expression result to match the declared return type.
      if (exprType.kind !== closureReturnType.kind) {
        const instrs = coercionInstrs(ctx, exprType, closureReturnType, liftedFctx);
        if (instrs.length > 0) {
          liftedFctx.body.push(...instrs);
        } else if (closureReturnType.kind === "externref" && exprType.kind === "f64") {
          // coercionInstrs may not have __box_number; fix the return type instead
          closureReturnType = exprType;
          liftedFctx.returnType = exprType;
          closureResults[0] = exprType;
          liftedFuncTypeIdx = addFuncType(ctx, liftedParams, closureResults, `${closureName}_type`);
          closureInfoForSelf.returnType = exprType;
          closureInfoForSelf.funcTypeIdx = liftedFuncTypeIdx;
        }
      }
    } else if (exprType !== null) {
      liftedFctx.body.push({ op: "drop" });
    }
  }

  // Clean up the temporary closure map entry for named function expressions
  if (funcExprName) {
    ctx.closureMap.delete(funcExprName);
  }

  // (#2118) Restore the outer closureMap entry for the self-recursive binding —
  // the temporary self entry must not leak into the enclosing scope's view of
  // the name (where the binding still resolves to the local/global slot).
  if (selfBindingName !== undefined && selfBindingName !== funcExprName) {
    if (hadSavedSelfBindingClosureInfo) {
      ctx.closureMap.set(selfBindingName, savedSelfBindingClosureInfo!);
    } else {
      ctx.closureMap.delete(selfBindingName);
    }
  }

  // Ensure return value for non-void functions (skip if concise body already left a value)
  emitClosureDefaultReturnValue(ctx, liftedFctx, closureReturnType, conciseBodyHasValue);

  if (savedFunc) ctx.funcStack.pop();
  if (savedFunc) ctx.parentBodiesStack.pop();
  ctx.currentFunc = savedFunc;

  return { liftedFctx, closureReturnType, liftedFuncTypeIdx };
}

/** (#4134) Report a lifted closure whose body escapes its own local frame. */
function reportClosureFrameBreach(
  ctx: CodegenContext,
  arrow: ts.ArrowFunction | ts.FunctionExpression,
  closureName: string,
  liftedFuncTypeIdx: number,
  liftedFctx: FunctionContext,
): void {
  const type = ctx.mod.types[liftedFuncTypeIdx];
  if (!type || type.kind !== "func") return;
  const frame = type.params.length + liftedFctx.locals.length;
  const localOps = new Set(["local.get", "local.set", "local.tee"]);
  let worst = -1;
  const walk = (instrs: readonly Instr[]): void => {
    for (const instr of instrs) {
      if (localOps.has(instr.op)) {
        const index = (instr as { index?: number }).index;
        if (typeof index === "number" && index >= frame && index > worst) worst = index;
      }
      for (const key of ["body", "then", "else", "catchAll"] as const) {
        const nested = (instr as unknown as Record<string, unknown>)[key];
        if (Array.isArray(nested)) walk(nested as Instr[]);
      }
      const catches = (instr as { catches?: { body?: Instr[] }[] }).catches;
      if (Array.isArray(catches)) for (const c of catches) if (Array.isArray(c.body)) walk(c.body);
    }
  };
  walk(liftedFctx.body);
  if (worst < 0) return;
  if (process.env?.JS2WASM_FRAME_OPS) {
    const flat: string[] = [];
    const dump = (instrs: readonly Instr[], depth: number): void => {
      for (const instr of instrs) {
        const idx = (instr as { index?: number }).index;
        flat.push(
          `${"  ".repeat(depth)}${instr.op}${idx === undefined ? "" : ` ${idx}`}${typeof idx === "number" && idx >= frame ? "   <<<< OUT OF FRAME" : ""}`,
        );
        for (const key of ["body", "then", "else", "catchAll"] as const) {
          const nested = (instr as unknown as Record<string, unknown>)[key];
          if (Array.isArray(nested)) dump(nested as Instr[], depth + 1);
        }
      }
    };
    dump(liftedFctx.body, 0);
    const stale = [...liftedFctx.localMap.entries()].filter(([, v]) => v >= frame);
    process.stderr.write(
      `[js2:frame-ops] ${closureName} params=${type.params.map((p) => p.kind).join(",")} locals=${liftedFctx.locals.map((l) => `${l.name}:${l.type.kind}`).join(",")}` +
        ` STALE-localMap=${stale.map(([k, v]) => `${k}->${v}`).join(",") || "none"}\n`,
    );
    for (const line of flat) process.stderr.write(`[js2:frame-ops]   ${line}\n`);
  }
  let text = "<unavailable>";
  try {
    text = arrow.getText().replace(/\s+/g, " ").slice(0, 200);
  } catch {
    // A synthesized node has no source text; the name and frame still localise it.
  }
  const file = arrow.getSourceFile?.()?.fileName ?? "<unknown>";
  process.stderr.write(
    `[js2:closure-frame] ${closureName} frame=${frame} (${type.params.length} params + ` +
      `${liftedFctx.locals.length} locals) worst=${worst}\n` +
      `[js2:closure-frame]   at ${file}\n[js2:closure-frame]   source: ${text}\n`,
  );
}

/**
 * (#4157) `JS2WASM_CLOSURE_NAME_MAP=1` prints one line per lifted closure
 * mapping the opaque emitted name (`__closure_N`, and by suffix its
 * `__closure_N__typed_this` twin) back to the source function it came from.
 * CPU profiles of compiled packages surface hot frames only under the emitted
 * name; without this map "which package function is hot" is guesswork.
 * Consumed by `scripts/profile-buckets.mjs`.
 */
function reportClosureNameMap(arrow: ts.ArrowFunction | ts.FunctionExpression, closureName: string): void {
  if (typeof process === "undefined" || !process.env?.JS2WASM_CLOSURE_NAME_MAP) return;
  let label = ts.isFunctionExpression(arrow) && arrow.name ? arrow.name.text : "";
  if (!label) {
    const parent = arrow.parent;
    if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      label = parent.left.getText();
    } else if (ts.isPropertyAssignment(parent) || ts.isVariableDeclaration(parent)) {
      label = parent.name.getText();
    }
  }
  const sourceFile = arrow.getSourceFile();
  const { line } = sourceFile.getLineAndCharacterOfPosition(arrow.getStart());
  console.error(`[js2:closure-map] ${closureName} <- ${label || "(anonymous)"} @${line + 1}`);
}

/**
 * A closure with no direct-eval subtree can still outlive and observe a var
 * binding created by direct eval in its owning activation. Thread the stable
 * pool pointer as an impossible-name internal capture, initialized before
 * construction so a closure created textually before eval does not capture a
 * null pre-state. A closure that reaches direct eval needs an inner+outer pool
 * chain and stays on the existing path; reusing its owner's pool would merge
 * two VarEnvs.
 */
function captureOwningDirectEvalState(
  ctx: CodegenContext,
  fctx: FunctionContext,
  arrow: ts.ArrowFunction | ts.FunctionExpression,
  reachesDirectEval: boolean,
  captures: ArrowClosureCapture[],
): void {
  if (
    !(ctx.standalone || ctx.wasi) ||
    reachesDirectEval ||
    (fctx.directEvalActivationStatePoolLocal === undefined &&
      !enclosingFunctionOwnScopeMayReachDirectEval(arrow, ctx.oracle))
  ) {
    return;
  }
  const state = emitEnsureDirectEvalActivationStatePoolInitialized(ctx, fctx);
  captures.push({
    name: RUNTIME_EVAL_STATE_POOL_CAPTURE_NAME,
    type: { kind: "externref" },
    localIdx: state.poolLocal,
    mutable: false,
    alreadyBoxed: false,
    hasTdzFlag: false,
    eagerDominatingBox: false,
  });
}

/** Compile an arrow function as a first-class closure value (Wasm GC struct + funcref) */
export function compileArrowAsClosure(
  ctx: CodegenContext,
  fctx: FunctionContext,
  arrow: ts.ArrowFunction | ts.FunctionExpression,
): ValType | null {
  const closureId = ctx.closureCounter++;
  const closureName = `__closure_${closureId}`;
  const body = recordClosureBody(ctx, "compileArrowAsClosure", closureName, arrow);
  reportClosureNameMap(arrow, closureName);

  // Check if this is a generator function expression (function*() { ... })
  const isGenerator = ts.isFunctionExpression(arrow) && arrow.asteriskToken !== undefined;
  if (isGenerator) ctx.generatorFunctions.add(closureName);
  // `isAsync` is still consumed below (generator-create name selection); the
  // return-type derivation moved into computeClosureWrapperSig.
  const isAsync = arrow.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ?? false;

  // 1. Determine arrow parameter types and return type. (#2939) Factored into
  //    `computeClosureWrapperSig` so the dynamic-dispatch candidate pre-scan
  //    registers the IDENTICAL wrapper type for inner-scope callbacks. The
  //    (#585 contextual-void / #2867 Gap-1 / async-unwrap / #1151 binding-pattern
  //    / #2640 array-callback-widen) logic all lives there now.
  const { params: arrowParams, returnType: closureReturnTypeInit } = computeClosureWrapperSig(ctx, arrow);
  let closureReturnType: ValType | null = closureReturnTypeInit;

  // (#2957 phase 2) Async state-machine activation for arrows / function
  // expressions. `computeClosureWrapperSig` above set `closureReturnType` to the
  // *unwrapped* awaited type (the legacy synchronous pass-through model), so an
  // async arrow silently returned a sync value instead of a Promise. Decide
  // activation NOW — before the lifted func type + closure struct are built —
  // and, on a match, bake the `externref` (Promise) result into the signature so
  // the struct's funcref field, the wrapper type, and every call site agree. The
  // body is emitted by the async machine at the statement-loop point below (see
  // `asyncDecision` use). Generators have their own async machinery and are
  // excluded here. The `__self` closure-env param (lifted param 0) is only ever
  // spilled by the CPS emitter when a live-after-await capture resolves to it;
  // the canonical single-tail-await (`return await P`) has no live-after set, so
  // the env param is untouched — richer shapes stay on the legacy path via the
  // predicate gate.
  const asyncDecision = isAsync && !isGenerator ? planAsyncClosureActivation(ctx, arrow, /*isAsync*/ true) : null;
  if (asyncDecision) {
    closureReturnType = { kind: "externref" };
  } else if (isAsync && !isGenerator) {
    // (#3587) Declined async arrow/fn-expr with a genuinely-suspending await
    // inside a `try`: refuse loudly instead of silently compiling the legacy
    // pass-through that cannot deliver awaited rejections.
    reportDeclinedAsyncRejectionHazard(ctx, arrow);
  }

  // 2. Analyze captured variables (referenced/written free vars, outer-write +
  //    TDZ-flag boxing) and the self-recursive binding — see planClosureCaptures.
  const reachesDirectEval = functionMayReachDirectEval(arrow, ctx.oracle);
  const additionalCaptureNames = planAdditionalWithEnvironmentCaptureNames(fctx, reachesDirectEval);
  const { captures, selfBindingName } = planClosureCaptures(ctx, fctx, arrow, body, additionalCaptureNames);
  captureOwningDirectEvalState(ctx, fctx, arrow, reachesDirectEval, captures);

  // 3. Create struct type: field 0 = funcref, fields 1..N = captured vars
  //    For mutable captures, the field type is a ref cell (struct { value: T })
  const closureResults: ValType[] = closureReturnType ? [closureReturnType] : [];

  // For closures with no captures, reuse the shared wrapper struct type from
  // getOrCreateFuncRefWrapperTypes. This ensures all no-capture closures with
  // the same signature share the same struct type, enabling consistent call_ref
  // dispatch when closures are passed as callable parameters (externref).
  const isNamedFuncExpr = ts.isFunctionExpression(arrow) && arrow.name;

  const mintedTypes = mintClosureStructTypes(ctx, {
    captures,
    arrowParams,
    closureResults,
    closureName,
    isNamedFuncExpr: !!isNamedFuncExpr,
    decl: arrow, // (#4437) the `$fnmeta` slot's source of `name` + §15.1.5 `length`
    constructible:
      (noJsHost(ctx) || ctx.targetProfile.semanticProviders === "native-first") &&
      ts.isFunctionExpression(arrow) &&
      arrow.asteriskToken === undefined &&
      !(arrow.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ?? false),
  });
  let { structTypeIdx, liftedFuncTypeIdx, liftedParams } = mintedTypes;
  const { liftedSelfTypeIdx } = mintedTypes;
  // (#4139) Record the node -> closure-struct mapping for the fnctor twin
  // build, which materializes the ctor's sibling captures from this struct.
  (ctx.closureStructByNode ??= new WeakMap()).set(arrow, { structTypeIdx });

  // 5. Build the lifted function body — extracted to compileLiftedClosureBody
  //    (#3683 S2) so the same AST can also be compiled as a typed-`this` twin.
  const generic = compileLiftedClosureBody(ctx, fctx, arrow, {
    closureName,
    captures,
    selfBindingName,
    arrowParams,
    closureResults,
    liftedParams,
    structTypeIdx,
    liftedSelfTypeIdx,
    liftedFuncTypeIdx,
    closureReturnType,
    isGenerator,
    isAsync,
    asyncDecision,
    isNamedFuncExpr: !!isNamedFuncExpr,
  });
  const liftedFctx = generic.liftedFctx;
  closureReturnType = generic.closureReturnType;
  liftedFuncTypeIdx = generic.liftedFuncTypeIdx;

  const liftedFuncIdx = mintDefinedFunc(ctx);
  // (#4134) `JS2WASM_CHECK_FRAMES=1` reports a lifted closure body that reads or
  // writes a local its own frame never declares, AT THE MOMENT IT IS CREATED,
  // together with the offending source text. The end-of-codegen checker can only
  // say which function is broken; this says which ARROW produced it, which is
  // the last link needed to reduce a fixture. Inert unless set.
  if (typeof process !== "undefined" && process.env?.JS2WASM_CHECK_FRAMES) {
    reportClosureFrameBreach(ctx, arrow, closureName, liftedFuncTypeIdx, liftedFctx);
  }
  pushProgramAbiNestedCallable(ctx, arrow, liftedFuncIdx, {
    name: closureName,
    typeIdx: liftedFuncTypeIdx,
    locals: liftedFctx.locals,
    body: liftedFctx.body,
    exported: false,
  });
  // (#1384) liftedFctx.body is now reachable via ctx.mod.functions[].body —
  // remove from liveBodies to keep it tight (the regular walker dedupes anyway).
  ctx.liveBodies.delete(liftedFctx.body);
  ctx.funcMap.set(closureName, liftedFuncIdx);
  let recordedTwin = false;

  // 6b. (#3683 S2) Typed-`this` TWIN. When this lifted closure is an admitted
  //     write-once fnctor prototype method, compile its body a SECOND time with
  //     the receiver arriving as a typed `(ref $__fnctor_F)` PARAMETER, then
  //     prepend a `ref.test` shim to the GENERIC body that casts
  //     `__current_this` and forwards on a shape hit. Detached receivers /
  //     patched prototypes / foreign shapes keep the untouched generic body.
  //     (#3683 S3) The twin's param 0 replaces `__self` — admission guarantees
  //     nothing reads it — which is what makes a devirtualized DIRECT call
  //     possible without materializing the closure singleton. See typed-this.ts
  //     for the equivalence argument behind the inline struct.get/struct.set
  //     branches and for the receiver-param design note.
  {
    const admitted = admitTypedThisTwin(ctx, arrow, {
      thisStructName: liftedFctx.thisStructName,
      captureCount: captures.length,
      selfBindingName,
      isGenerator,
      isAsync,
      isNamedFuncExpr: !!isNamedFuncExpr,
    });
    if (admitted) {
      const twinName = `${closureName}__typed_this`;
      // The twin's own wasm type: `(ref $__fnctor_F, ...userParams) -> results`.
      // `return_call` constrains only RESULTS to match the caller, so the shim
      // in the generic body can tail-call across this param-type difference.
      const useReceiverParam = directCallLoweringEnabled();
      const twinParams: ValType[] = useReceiverParam
        ? [{ kind: "ref", typeIdx: admitted.structTypeIdx }, ...arrowParams]
        : liftedParams;
      // (#3754) NUMERIC-RETURN twin. When the whole-program fixpoint proved this
      // method returns a number on every path, the twin is minted with `f64`
      // results instead of the declaration-derived `externref` — see
      // `refinedTwinReturnType` for why that is sound and why it cannot produce
      // a stack-type mismatch. Skipped under `JS2WASM_DIRECT_CALLS=0`, where the
      // twin SHARES the generic body's func type and so cannot diverge from it.
      const refinedReturn = useReceiverParam ? refinedTwinReturnType(ctx, arrow, closureReturnType ?? null) : undefined;
      const twinResults: ValType[] = refinedReturn ? [refinedReturn] : [...closureResults];
      const twinTypeIdx = useReceiverParam
        ? addFuncType(ctx, twinParams, twinResults, `${twinName}_type`)
        : liftedFuncTypeIdx;
      const twin = compileLiftedClosureBody(ctx, fctx, arrow, {
        closureName: twinName,
        captures,
        selfBindingName,
        arrowParams,
        // The concise-body return repair cannot fire (admission requires a
        // BLOCK body), but this is the twin's OWN array so a future shape
        // change can never let it rewrite the generic's results in place.
        closureResults: twinResults,
        liftedParams: twinParams,
        structTypeIdx,
        liftedSelfTypeIdx,
        liftedFuncTypeIdx: twinTypeIdx,
        // The refined type is IMPOSED on the body, not asserted over it: every
        // `return` coerces to it through the normal path, which is total for
        // every kind a return expression can lower to.
        closureReturnType: refinedReturn ?? closureReturnType,
        isGenerator,
        isAsync,
        asyncDecision,
        isNamedFuncExpr: !!isNamedFuncExpr,
        typedThis: { fnctorStructTypeIdx: admitted.structTypeIdx, structName: admitted.structName },
      });
      // Admission requires a block body, so the concise-body return-type repair
      // (the only thing that can rewrite `liftedFuncTypeIdx`) cannot have fired
      // — but assert it rather than trust it: a repaired twin's RESULTS would no
      // longer match the generic's, and the shim's `return_call` would emit a
      // module that fails validation. That is much worse than silently skipping
      // one monomorphization.
      if (twin.liftedFuncTypeIdx !== twinTypeIdx) {
        // Discard the twin (its body is unreferenced; the compile's other
        // effects — late imports, string constants, dispatcher reservations —
        // are all idempotent) and keep the generic body as the only lowering.
        ctx.liveBodies.delete(twin.liftedFctx.body);
      } else {
        const twinFuncIdx = mintDefinedFunc(ctx);
        pushProgramAbiTypedThisTwin(ctx, arrow, twinFuncIdx, {
          name: twinName,
          typeIdx: twin.liftedFuncTypeIdx,
          locals: twin.liftedFctx.locals,
          body: twin.liftedFctx.body,
          exported: false,
        });
        ctx.liveBodies.delete(twin.liftedFctx.body);
        ctx.funcMap.set(twinName, twinFuncIdx);
        recordDirectCallTwin(ctx, arrow, twinName, twinParams, twinResults);
        recordedTwin = true;
        // Prepend IN PLACE: `liftedFctx.body` is the same array object already
        // registered as the generic function's body, and it stays covered by
        // `shiftLateImportIndices` (which walks `ctx.mod.functions`), so the
        // baked `return_call twinFuncIdx` shifts with any later late-import
        // addition. The guard's scratch anyref local is appended to the SAME
        // `locals` array `pushDefinedFunc` already captured by reference.
        const guardTmp = useReceiverParam
          ? allocLocal(liftedFctx, `__tt_shim_${liftedFctx.locals.length}`, { kind: "anyref" })
          : undefined;
        // (#3754) A refined twin's results no longer equal the generic body's,
        // so the shim cannot tail-call it — box on the way back out instead.
        // Read `__box_number` HERE rather than at refinement time: compiling
        // the twin above may have added late imports, which shift every
        // function index (the same reason `twinFuncIdx` is minted after it).
        // A module without the helper keeps the tail call and the boxed twin.
        const boxNumberIdx = refinedReturn !== undefined ? ctx.funcMap.get("__box_number") : undefined;
        const boxTwinResult: Instr[] | undefined =
          boxNumberIdx === undefined ? undefined : [{ op: "call", funcIdx: boxNumberIdx }];
        // `refinedTwinReturnType` already required the helper to be resolvable,
        // so this cannot normally miss; if it ever did, emit NO shim rather than
        // an ill-typed tail call. The generic body then simply stays generic —
        // the direct-call trampolines still reach the twin, so the only cost is
        // an unmonomorphized dynamic entry.
        if (refinedReturn === undefined || boxTwinResult !== undefined) {
          liftedFctx.body.unshift(
            ...buildTypedThisForwardGuard(
              admitted.structTypeIdx,
              ensureCurrentThisGlobal(ctx),
              liftedFctx.params.length,
              twinFuncIdx,
              guardTmp,
              boxTwinResult,
            ),
          );
        }
        ctx.typedThisTwinCount = (ctx.typedThisTwinCount ?? 0) + 1;
      }
    }
  }

  const directGenericGlobalIdx = recordedTwin
    ? undefined
    : recordDirectCallGeneric(ctx, arrow, closureName, structTypeIdx, liftedParams, closureResults);

  const constructionMeta = registerStandaloneDomCallbackDirectClosure(ctx, arrow, {
    structTypeIdx,
    liftedFuncTypeIdx,
    closureReturnType,
    arrowParams,
    inlineBody: captureFreeNumericInlineBody(arrow, captures.length, liftedFctx, arrowParams.length),
    liftedFuncIdx,
    baseConstruction: mintedTypes.meta,
  });

  // 7. At the creation site, emit struct.new with funcref + arity + captured values.
  const hasRestParam = runtimeParameters(arrow).some((param) => param.dotDotDotToken !== undefined);
  emitClosureConstruction(
    ctx,
    fctx,
    captures,
    liftedFuncIdx,
    structTypeIdx,
    hasRestParam ? Math.max(0, arrowParams.length - 1) : arrowParams.length,
    constructionMeta, // (#4437) plus the certified DOM callback carrier, when present
  );
  if (directGenericGlobalIdx !== undefined) {
    // Keep one typed handle to the exact closure instance installed on the
    // write-once prototype. The assignment still consumes the same value:
    // store it, then reload and narrow the nullable global back to the
    // non-null allocation type left by `struct.new`.
    fctx.body.push(
      { op: "global.set", index: directGenericGlobalIdx },
      { op: "global.get", index: directGenericGlobalIdx },
      { op: "ref.as_non_null" },
    );
  }

  return { kind: "ref", typeIdx: structTypeIdx };
}

const NUMERIC_CLOSURE_INLINE_OPS = new Set<string>([
  "i32.const",
  "i32.add",
  "i32.sub",
  "i32.mul",
  "i32.div_s",
  "i32.rem_s",
  "i32.eq",
  "i32.ne",
  "i32.lt_s",
  "i32.le_s",
  "i32.gt_s",
  "i32.ge_s",
  "i32.eqz",
  "f64.const",
  "f64.add",
  "f64.sub",
  "f64.mul",
  "f64.div",
  "f64.rem",
  "f64.eq",
  "f64.ne",
  "f64.lt",
  "f64.le",
  "f64.gt",
  "f64.ge",
  // Numeric helpers such as JS remainder lower to a direct Wasm function
  // call. The surrounding body remains straight-line and is copied once at
  // the original call site, so effects/traps and evaluation order are intact.
  "call",
]);
const NUMERIC_CLOSURE_INLINE_MAX_INSTRS = 10;

/**
 * Extract the tiny expression-shaped numeric callbacks that array HOF loops
 * can inline without materializing call-site state. The body must be
 * capture-free, local-free, and consist only of parameter reads plus scalar
 * arithmetic/comparisons. Anything scope-, heap-, trap-, or call-sensitive
 * retains the ordinary closure call_ref path.
 */
function captureFreeNumericInlineBody(
  arrow: ts.ArrowFunction | ts.FunctionExpression,
  captureCount: number,
  liftedFctx: FunctionContext,
  paramCount: number,
): Instr[] | undefined {
  if (
    captureCount !== 0 ||
    liftedFctx.locals.length !== 0 ||
    arrow.parameters.some((param) => param.dotDotDotToken || param.initializer) ||
    (ts.isBlock(arrow.body) && closureBodyUsesArguments(arrow.body))
  ) {
    return undefined;
  }
  const body = liftedFctx.body.filter((instr) => instr.op !== "nop");
  if (body.at(-1)?.op === "return") body.pop();
  if (body.length === 0 || body.length > NUMERIC_CLOSURE_INLINE_MAX_INSTRS) return undefined;
  for (const instr of body) {
    if (instr.op === "local.get") {
      const index = (instr as { index: number }).index;
      if (index < 1 || index > paramCount) return undefined;
      continue;
    }
    if (!NUMERIC_CLOSURE_INLINE_OPS.has(instr.op)) return undefined;
  }
  return body.map((instr) => ({ ...instr }));
}

/**
 * Resolve a callback name by checker binding identity rather than by its
 * spelling in `funcMap`. The function map is intentionally name-indexed, so a
 * user function can collide with a lexical local of the same name.
 */
function callbackBindingDeclaration(
  ctx: CodegenContext,
  arrow: ts.ArrowFunction | ts.FunctionExpression,
  body: ts.ConciseBody,
  name: string,
): ts.Declaration | undefined {
  let declaration: ts.Declaration | undefined;
  let sawReference = false;
  let ambiguous = false;

  const isReferenceIdentifier = (node: ts.Identifier): boolean => {
    const parent = node.parent;
    if (!parent) return true;
    if (ts.isVariableDeclaration(parent) && parent.name === node) return false;
    if (ts.isParameter(parent) && parent.name === node) return false;
    if (ts.isBindingElement(parent) && parent.name === node) return false;
    if (
      (ts.isFunctionDeclaration(parent) ||
        ts.isFunctionExpression(parent) ||
        ts.isClassDeclaration(parent) ||
        ts.isClassExpression(parent)) &&
      parent.name === node
    ) {
      return false;
    }
    if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
    if (ts.isPropertyAssignment(parent) && parent.name === node) return false;
    if (ts.isLabeledStatement(parent) && parent.label === node) return false;
    if ((ts.isBreakStatement(parent) || ts.isContinueStatement(parent)) && parent.label === node) return false;
    return true;
  };

  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === name && isReferenceIdentifier(node)) {
      sawReference = true;
      const resolved = ctx.oracle.valueDeclarationOf(node);
      if (!resolved) {
        ambiguous = true;
      } else if (declaration && declaration !== resolved) {
        ambiguous = true;
      } else {
        declaration = resolved;
      }
    }
    node.forEachChild(visit);
  };

  if (ts.isBlock(body)) {
    for (const statement of body.statements) visit(statement);
  } else {
    visit(body);
  }
  for (const parameter of arrow.parameters) {
    if (parameter.initializer) visit(parameter.initializer);
    if (!ts.isIdentifier(parameter.name)) visit(parameter.name);
  }

  if (!sawReference) return undefined;
  if (ambiguous || !declaration) return undefined;
  return declaration;
}

/** Whether a checker declaration denotes a callable value in `funcMap`. */
function isCallbackFunctionDeclaration(declaration: ts.Declaration | undefined): boolean {
  if (!declaration) return false;
  if (
    ts.isFunctionDeclaration(declaration) ||
    ts.isFunctionExpression(declaration) ||
    ts.isArrowFunction(declaration) ||
    ts.isMethodDeclaration(declaration) ||
    ts.isGetAccessorDeclaration(declaration) ||
    ts.isSetAccessorDeclaration(declaration) ||
    ts.isClassDeclaration(declaration) ||
    ts.isClassExpression(declaration)
  ) {
    return true;
  }
  if (!ts.isVariableDeclaration(declaration) || !declaration.initializer) return false;
  let initializer = declaration.initializer;
  while (
    ts.isParenthesizedExpression(initializer) ||
    ts.isAsExpression(initializer) ||
    ts.isTypeAssertionExpression(initializer) ||
    ts.isNonNullExpression(initializer) ||
    ts.isSatisfiesExpression(initializer)
  ) {
    initializer = initializer.expression;
  }
  return ts.isFunctionExpression(initializer) || ts.isArrowFunction(initializer) || ts.isClassExpression(initializer);
}

/** Compile an arrow function as a host callback via __make_callback.
 *  Captures are bundled into a per-instance GC struct (not shared globals). */
/**
 * (#2128) Collect the names a callback body WRITES that resolve to locals of
 * the enclosing function — i.e. its mutable captures. Used by the
 * object-literal accessor path to pre-compute, across a whole get/set pair,
 * which locals must be captured through a SHARED ref cell so the getter
 * observes the setter's writes.
 */
export function collectMutatedCaptureNames(
  fctx: FunctionContext,
  arrow: ts.ArrowFunction | ts.FunctionExpression,
): Set<string> {
  const ownLocals = arrowOwnLocals(arrow);
  const written = new Set<string>();
  const body = arrow.body;
  collectOverBody(collectWrittenIdentifiers, body, written, ownLocals);
  const result = new Set<string>();
  for (const name of written) {
    if (fctx.localMap.has(name)) result.add(name);
  }
  return result;
}

/** (#2128) Per-literal registry of shared capture ref cells — see compileArrowAsCallback. */
export type SharedRefCellMap = Map<string, { refCellLocal: number; refCellTypeIdx: number; valType: ValType }>;

export function compileArrowAsCallback(
  ctx: CodegenContext,
  fctx: FunctionContext,
  arrow: ts.ArrowFunction | ts.FunctionExpression,
  options?: {
    needsThis?: boolean;
    deferredInvocation?: boolean;
    /**
     * (#2128) Locals to capture mutably (via ref cell) even when THIS
     * callback only reads them — a sibling callback in the same object
     * literal writes them, and both must see one shared cell.
     */
    forceMutableCaptures?: Set<string>;
    /**
     * (#2128) Per-object-literal shared-cell registry. The first callback
     * capturing a name mutably creates the cell and records it here; sibling
     * callbacks reuse it so mutations are visible across the get/set pair.
     * Scoped to one literal compilation — do NOT share across loop-iteration
     * callback creations (per-iteration `let` semantics need fresh cells).
     */
    sharedRefCells?: SharedRefCellMap;
  },
): ValType | null {
  const cbId = ctx.callbackCounter++;
  const cbName = `__cb_${cbId}`;
  const body = arrow.body;

  // 1. Analyze captured variables (scope-aware so own params/var-decls shadow)
  const ownLocals = arrowOwnLocals(arrow);

  const referencedNames = new Set<string>();
  collectOverBody(collectReferencedIdentifiers, body, referencedNames, ownLocals);
  // (#3096) Also capture free variables referenced only in a parameter default
  // initializer / binding-pattern element default / computed key (see the
  // rationale on the identical scan in `compileArrowAsClosure`).
  collectParamDefaultReferences(arrow.parameters, referencedNames, ownLocals);
  // Keep the direct references separate from names added by the transitive
  // nested-function walk below. A transitive name is a real environment value
  // needed by that nested function even when a same-spelled user function is
  // present in the global `funcMap`.
  const directReferencedNames = addWithEnvironmentCaptureNames(referencedNames, fctx);

  // Import bindings are live module views, so callback closures must read the
  // aliased function/global at invocation time instead of capturing an early
  // module-initializer staging value.
  for (const name of [...referencedNames]) {
    if (
      (ctx.moduleGlobals.has(name) || ctx.funcMap.has(name) || ctx.closureMap.has(name)) &&
      closureNameResolvesToImportBinding(ctx, arrow, name)
    ) {
      referencedNames.delete(name);
    }
  }

  // A host callback can call a capturing nested declaration. Its callback
  // frame must carry that declaration's environment just like a lifted Wasm
  // closure does; otherwise the direct call reads owner-frame local indices
  // from the callback frame.
  const transitivelyRequiredNames = collectTransitiveCaptureNames(
    ctx.nestedFuncCaptures,
    referencedNames,
    ownLocals,
    () => false,
  );

  // Detect which captured variables are written inside the callback body (#859)
  const writtenInCallback = new Set<string>();
  collectOverBody(collectWrittenIdentifiers, body, writtenInCallback, ownLocals);

  const captures: { name: string; type: ValType; localIdx: number; mutable: boolean; alreadyBoxed: boolean }[] = [];
  for (const name of referencedNames) {
    const localIdx = fctx.localMap.get(name);
    if (localIdx === undefined) continue;
    // #2669: skip a name only when the checker says THIS callback reference
    // resolves to a callable declaration. `funcMap` is name-indexed, so its
    // entry can collide with a lexical local (lodash's `result` callback).
    // Names added transitively above are always environment captures; the
    // nested function's capture record already proves that they are needed.
    const bindingDeclaration = directReferencedNames.has(name)
      ? callbackBindingDeclaration(ctx, arrow, body, name)
      : undefined;
    if (
      ctx.funcMap.has(name) &&
      ctx.funcMap.get(name) !== ctx.jsStringImports.get(name) &&
      directReferencedNames.has(name) &&
      isCallbackFunctionDeclaration(bindingDeclaration) &&
      !transitivelyRequiredNames.has(name) &&
      !fctx.hoistedFunctionValueBindings?.has(name)
    ) {
      continue;
    }
    // Skip if the name is the arrow's own parameter (including destructuring bindings)
    if (isOwnParamName(arrow, name)) continue;
    const type =
      localIdx < fctx.params.length
        ? fctx.params[localIdx]!.type
        : (fctx.locals[localIdx - fctx.params.length]?.type ?? { kind: "f64" });
    // (#2128) forceMutableCaptures: a sibling accessor in the same object
    // literal writes this local — capture via the shared ref cell even if
    // this callback (e.g. the getter) only reads it.
    const isMutable = writtenInCallback.has(name) || (options?.forceMutableCaptures?.has(name) ?? false);
    const alreadyBoxed = !!fctx.boxedCaptures?.has(name);
    captures.push({ name, type, localIdx, mutable: isMutable, alreadyBoxed });
  }

  // 2. Create capture struct type (if captures exist)
  //    For mutable captures, use ref cell types so mutations persist (#859)
  let capStructTypeIdx = -1;
  if (captures.length > 0) {
    // Build fields first -- getOrRegisterRefCellType may add types to ctx.mod.types
    const fields: FieldDef[] = captures.map((cap) => buildCaptureFieldDef(ctx, cap));
    // Set capStructTypeIdx AFTER building fields (which may register new ref cell types)
    capStructTypeIdx = ctx.mod.types.length;
    ctx.mod.types.push({
      kind: "struct",
      name: `__cb_cap_${cbId}`,
      fields,
    } as StructTypeDef);
  }

  // 3. Build the __cb_N function — first param is externref captures
  //    Callback params that are ref/ref_null must be declared as externref
  //    because the JS host will pass them as externref. We convert them back
  //    to the expected struct ref type at the start of the body.
  const needsThis = options?.needsThis === true;
  const cbResolvedParams: ValType[] = []; // original resolved types for coercion
  const cbParams: ValType[] = [{ kind: "externref" }]; // captures param [0]
  // When needsThis=true, inject 'this' as param [1] (externref receiver)
  if (needsThis) cbParams.push({ kind: "externref" });
  // (#3359) A TS `this` param is type-level only — never a runtime callback arg.
  const cbArrowParams = runtimeParameters(arrow);
  for (const p of cbArrowParams) {
    const paramType = ctx.checker.getTypeAtLocation(p);
    const resolved = resolveWasmType(ctx, paramType);
    cbResolvedParams.push(resolved);
    // JS host passes all values as externref for GC ref types — they cannot
    // be passed as (ref N) or (ref null N) directly from JS
    if (resolved.kind === "ref" || resolved.kind === "ref_null") {
      cbParams.push({ kind: "externref" });
    } else {
      cbParams.push(resolved);
    }
  }

  // #1606: For functions parsed from a foreign SourceFile (e.g. statically
  // inlined `eval("...")` bodies), the checker has no symbol binding for the
  // declaration. `getSignatureFromDeclaration` then dereferences `.declarations`
  // on an undefined symbol deep inside TypeScript and throws
  // "Cannot read properties of undefined (reading 'declarations')". Guard the
  // signature/return-type resolution so the callback compiles with a void/any
  // return type instead of crashing the whole compile — the body still coerces
  // its actual return value via the normal path.
  let cbReturnType: ValType | null = null;
  try {
    const sig = ctx.checker.getSignatureFromDeclaration(arrow);
    if (sig) {
      const retType = ctx.checker.getReturnTypeOfSignature(sig);
      if (!isVoidType(retType)) {
        // (#3051 Slice 3) see resolveWasmTypeForClosureReturn — accessor-bearing
        // object-literal return types lower to externref (host plain objects).
        cbReturnType = resolveWasmTypeForClosureReturn(ctx, retType);
      }
    }
  } catch {
    cbReturnType = null;
  }

  const cbResults: ValType[] = cbReturnType ? [cbReturnType] : [];
  const cbTypeIdx = addFuncType(ctx, cbParams, cbResults, `${cbName}_type`);

  // arrowParamOffset: index of the first arrow parameter in cbParams/cbFctx.params
  // = 1 (captures) + 1 (this, if needsThis)
  const arrowParamOffset = needsThis ? 2 : 1;

  const cbFctxParams: FunctionContext["params"] = [{ name: "__captures", type: { kind: "externref" } }];
  if (needsThis) {
    cbFctxParams.push({ name: "__this", type: { kind: "externref" } });
  }
  for (let i = 0; i < cbArrowParams.length; i++) {
    const p = cbArrowParams[i]!;
    cbFctxParams.push({
      name: ts.isIdentifier(p.name) ? p.name.text : `__param${i}`,
      type: cbParams[arrowParamOffset + i] ?? { kind: "f64" as const },
    });
  }

  const cbFctx: FunctionContext = {
    name: cbName,
    params: cbFctxParams,
    locals: [],
    localMap: new Map(),
    returnType: cbReturnType,
    body: [],
    blockDepth: 0,
    breakStack: [],
    continueStack: [],
    labelMap: new Map(),
    savedBodies: [],
    enclosingClassName: fctx.enclosingClassName ?? resolveEnclosingClassName(fctx),
    // (#1395) Same propagation as the lifted-arrow path above so callbacks
    // spawned inside static initializers / static methods resolve `this`
    // to the class-object singleton.
    isStaticContext: fctx.isStaticContext,
    // (#1636-S1) Anonymous callbacks are dispatchable from the host via
    // `__call_fn_method_N`, which installs the host receiver into
    // `__current_this`. Allow `this` to read it when no other binding exists.
    // (When needsThis=true, `this` is already bound to the `__this` param at
    // localMap index 1, so the fallback is never reached for that path.)
    readsCurrentThis: true,
    captureExternrefNames: new Set(captures.filter((cap) => cap.type.kind === "externref").map((cap) => cap.name)),
  };

  // (#1384) Track cbFctx.body in liveBodies BEFORE any emission so addUnionImports
  // / shiftLateImportIndices can shift any `call funcIdx` instructions that get
  // emitted into it during the captures-extraction (step 4) and param-coercion
  // (step 4b) phases — both run BEFORE the savedFunc swap at step 5 that would
  // otherwise expose cbFctx via ctx.currentFunc / funcStack to the shifter.
  ctx.liveBodies.add(cbFctx.body);

  // Register params as locals (param 0 = __captures, [1 = __this if needsThis], then arrow params)
  for (let i = 0; i < cbFctx.params.length; i++) {
    cbFctx.localMap.set(cbFctx.params[i]!.name, i);
  }
  // When needsThis=true, also register 'this' keyword → index 1 (__this param)
  if (needsThis) {
    cbFctx.localMap.set("this", 1);
  }

  // 4. Extract captures from struct into locals at start of __cb_N body
  if (captures.length > 0) {
    // Convert externref captures → anyref → ref $__cb_cap_N
    const capLocal = allocLocal(cbFctx, `__cap_ref`, { kind: "ref", typeIdx: capStructTypeIdx });
    cbFctx.body.push({ op: "local.get", index: 0 }); // __captures externref
    cbFctx.body.push({ op: "any.convert_extern" });
    cbFctx.body.push({ op: "ref.cast", typeIdx: capStructTypeIdx });
    cbFctx.body.push({ op: "local.set", index: capLocal });

    for (let i = 0; i < captures.length; i++) {
      const cap = captures[i]!;
      const outerBoxed = fctx.boxedCaptures?.get(cap.name);
      if (cap.mutable) {
        // Mutable capture: the struct field holds a ref cell (#859).
        let refCellTypeIdx: number;
        let valType: ValType;
        if (cap.alreadyBoxed && (cap.type.kind === "ref" || cap.type.kind === "ref_null")) {
          refCellTypeIdx = (cap.type as { typeIdx: number }).typeIdx;
          const outerInfo = fctx.boxedCaptures?.get(cap.name);
          // (#3328) Cell field-0 type as the fallback — see the arrow-lift arm.
          valType = outerInfo?.valType ?? refCellValueType(ctx, refCellTypeIdx) ?? { kind: "f64" };
        } else {
          refCellTypeIdx = getOrRegisterRefCellType(ctx, cap.type);
          valType = cap.type;
        }
        const refCellType: ValType = { kind: "ref_null", typeIdx: refCellTypeIdx };
        const localIdx = allocLocal(cbFctx, cap.name, refCellType);
        cbFctx.body.push({ op: "local.get", index: capLocal });
        cbFctx.body.push({ op: "struct.get", typeIdx: capStructTypeIdx, fieldIdx: i });
        cbFctx.body.push({ op: "local.set", index: localIdx });
        if (!cbFctx.boxedCaptures) cbFctx.boxedCaptures = new Map();
        cbFctx.boxedCaptures.set(cap.name, { refCellTypeIdx, valType });
      } else if (outerBoxed && (cap.type.kind === "ref" || cap.type.kind === "ref_null")) {
        // Already-boxed capture (read-only in this callback): store the ref cell
        const refCellType: ValType = { kind: "ref_null", typeIdx: outerBoxed.refCellTypeIdx };
        const localIdx = allocLocal(cbFctx, cap.name, refCellType);
        cbFctx.body.push({ op: "local.get", index: capLocal });
        cbFctx.body.push({ op: "struct.get", typeIdx: capStructTypeIdx, fieldIdx: i });
        cbFctx.body.push({ op: "local.set", index: localIdx });
        if (!cbFctx.boxedCaptures) cbFctx.boxedCaptures = new Map();
        cbFctx.boxedCaptures.set(cap.name, { refCellTypeIdx: outerBoxed.refCellTypeIdx, valType: outerBoxed.valType });
      } else {
        const localIdx = allocLocal(cbFctx, cap.name, cap.type);
        cbFctx.body.push({ op: "local.get", index: capLocal });
        cbFctx.body.push({ op: "struct.get", typeIdx: capStructTypeIdx, fieldIdx: i });
        cbFctx.body.push({ op: "local.set", index: localIdx });
      }
    }
  }
  // Callback captures are materialized into locals in this frame before the
  // callback body is compiled.  Freeze those slots so a nested sibling call
  // prepends the extracted capture rather than reusing the declaring frame's
  // `outerLocalIdx` (which can alias a callback parameter such as `event`).
  recordCaptureSlots(
    cbFctx,
    captures.map((capture) => capture.name),
  );
  rehydrateWithEnvironmentScopes(fctx, cbFctx, cbName, ownLocals);
  // 4b. Convert ref/ref_null params from externref to their resolved types.
  //     The JS host passes all GC ref types as externref, so we need to convert
  //     them back at the start of the body.
  for (let i = 0; i < cbResolvedParams.length; i++) {
    const resolved = cbResolvedParams[i]!;
    if (resolved.kind === "ref" || resolved.kind === "ref_null") {
      const paramIdx = arrowParamOffset + i; // offset past __captures [and __this if needsThis]
      const paramName = cbFctx.params[paramIdx]!.name;
      // Allocate a new local with the resolved (struct ref) type
      const convertedIdx = allocLocal(cbFctx, `__converted_${paramName}`, resolved);
      // Load the externref param, convert to struct ref, store in new local
      cbFctx.body.push({ op: "local.get", index: paramIdx });
      coerceType(ctx, cbFctx, { kind: "externref" }, resolved);
      cbFctx.body.push({ op: "local.set", index: convertedIdx });
      // Update the localMap so the body code uses the converted local
      cbFctx.localMap.set(paramName, convertedIdx);
    }
  }

  // 5. Compile the callback body
  const savedFunc = ctx.currentFunc;
  if (savedFunc) ctx.parentBodiesStack.push(savedFunc.body);
  if (savedFunc) ctx.funcStack.push(savedFunc);
  ctx.currentFunc = cbFctx;

  // Emit default-value initialization for simple params with defaults
  emitArrowParamDefaults(ctx, cbFctx, arrow, arrowParamOffset /* skip __captures [and __this] */);

  // Emit destructuring code for binding pattern parameters (#3359: over the
  // this-param-stripped list, aligned with cbResolvedParams / cbFctxParams).
  for (let i = 0; i < cbArrowParams.length; i++) {
    const param = cbArrowParams[i]!;
    if (ts.isObjectBindingPattern(param.name) || ts.isArrayBindingPattern(param.name)) {
      const resolved = cbResolvedParams[i] ?? { kind: "f64" as const };
      const paramName = cbFctx.params[arrowParamOffset + i]?.name ?? `__param${i}`;
      const effectiveIdx = cbFctx.localMap.get(paramName) ?? arrowParamOffset + i;
      emitArrowParamDestructuring(ctx, cbFctx, param, effectiveIdx, resolved);
    }
  }

  // Pre-hoist function-scoped `var` declarations into the callback's localMap
  // so they shadow same-named module globals (#1745, ECMA-262 §10.2.10) —
  // mirrors the lifted-closure path above and function-body.ts.
  if (ts.isBlock(body)) {
    hoistVarDeclarations(ctx, cbFctx, body.statements);
  }

  // Pre-hoist let/const with TDZ flags for the callback body (#790)
  prepareLiftedFrameDeclarations(ctx, cbFctx, body, false);

  let exprBodyHasReturnValue = false;
  if (ts.isBlock(body)) {
    for (const stmt of body.statements) {
      compileStatement(ctx, cbFctx, stmt);
    }
  } else {
    const exprType = compileExpression(ctx, cbFctx, body);
    if (exprType !== null && cbReturnType) {
      // Expression result is the return value — already on stack
      exprBodyHasReturnValue = true;
      // Coerce expression type to declared return type if needed
      if (exprType.kind !== cbReturnType.kind) {
        const instrs = coercionInstrs(ctx, exprType, cbReturnType, cbFctx);
        if (instrs.length > 0) {
          cbFctx.body.push(...instrs);
        }
      }
    } else if (exprType !== null) {
      cbFctx.body.push({ op: "drop" });
    }
  }

  emitClosureDefaultReturnValue(ctx, cbFctx, cbReturnType, exprBodyHasReturnValue);

  if (savedFunc) ctx.funcStack.pop();
  if (savedFunc) ctx.parentBodiesStack.pop();
  ctx.currentFunc = savedFunc;

  const cbFuncIdx = mintDefinedFunc(ctx);
  pushProgramAbiNestedCallable(ctx, arrow, cbFuncIdx, {
    name: cbName,
    typeIdx: cbTypeIdx,
    locals: cbFctx.locals,
    body: cbFctx.body,
    exported: true,
  });
  // (#1384) cbFctx.body is now reachable via ctx.mod.functions[].body — the
  // regular shifter walker covers it from here on. Remove from liveBodies to
  // avoid double-traversal (the walker dedupes via its `shifted` set anyway,
  // but keeping liveBodies tight is cheaper).
  ctx.liveBodies.delete(cbFctx.body);
  ctx.funcMap.set(cbName, cbFuncIdx);
  ctx.mod.exports.push({
    name: cbName,
    desc: { kind: "func", index: cbFuncIdx },
  });

  // 7. At creation site: push cbId + captures externref, call __make_callback / __make_getter_callback
  // (#4394) The bridge's [[Construct]] must mirror the source callable's — see
  // codegen/callback-ctor-bridge.ts.
  const makeCallbackName = resolveCallbackMakerName(ctx, fctx, arrow, needsThis);
  const makeCallbackIdx = ctx.funcMap.get(makeCallbackName);
  if (makeCallbackIdx === undefined) {
    // (#3235) Standalone/WASI intentionally doesn't register the `__make_callback`
    // host bridge (declarations.ts). Rather than hard-error, degrade a callback
    // that reaches this host-bridge path to the native first-class closure struct;
    // the #3098 substrate (`__apply_closure`/`__call_fn_N`) invokes it host-free
    // wherever it's exercised. JS-host lane unaffected (idx always defined there).
    if (ctx.standalone || ctx.wasi) {
      return compileArrowAsClosure(ctx, fctx, arrow);
    }
    reportError(ctx, arrow, `Missing ${makeCallbackName} import`);
    return null;
  }

  fctx.body.push({ op: "i32.const", value: cbId });

  if (captures.length > 0) {
    // Push captured locals and create struct.
    // For mutable captures, create ref cells and keep locals for writeback (#859).
    const refCellLocals: { refCellLocal: number; outerLocalIdx: number; refCellTypeIdx: number; valType: ValType }[] =
      [];
    for (const cap of captures) {
      if (cap.mutable && !cap.alreadyBoxed) {
        const refCellTypeIdx = getOrRegisterRefCellType(ctx, cap.type);
        // (#2128) Reuse the literal's shared cell when a sibling callback
        // already created one for this local (same ref-cell type), so the
        // get/set pair aliases ONE cell. No new writebacks: the creator
        // registered them.
        const shared = options?.sharedRefCells?.get(cap.name);
        if (shared && shared.refCellTypeIdx === refCellTypeIdx) {
          fctx.body.push({ op: "local.get", index: shared.refCellLocal });
          continue;
        }
        // Create a ref cell: struct.new $ref_cell_T (value)
        fctx.body.push({ op: "local.get", index: cap.localIdx });
        fctx.body.push({ op: "struct.new", typeIdx: refCellTypeIdx });
        // Keep a local ref to the ref cell for writeback after the host call
        const refCellLocal = allocLocal(fctx, `__cb_rc_${cap.name}_${cbId}`, {
          kind: "ref_null",
          typeIdx: refCellTypeIdx,
        });
        fctx.body.push({ op: "local.tee", index: refCellLocal });
        // The struct.new result (ref cell) is on the stack for the capture struct
        refCellLocals.push({ refCellLocal, outerLocalIdx: cap.localIdx, refCellTypeIdx, valType: cap.type });
        options?.sharedRefCells?.set(cap.name, { refCellLocal, refCellTypeIdx, valType: cap.type });
        // (#3051 Slice 3) Stored accessor callbacks (needsThis): rebind the
        // OUTER local to the shared cell (`boxedCaptures` + localMap — the
        // closure path's convention, closures.ts ~467) so outer WRITES after
        // creation flow through the cell and the stored getter observes them.
        // The cell→local writebacks below only sync the reverse direction
        // (callback writes → outer reads) and only after call expressions; an
        // outer reassignment between host calls (`badLastIndex = Symbol.split`
        // in test262 @@split str-coerce-lastindex-err) was invisible to the
        // getter, which kept reading the creation-time snapshot. The orphaned
        // original local slot keeps receiving writebacks — harmless (no reads
        // resolve to it once localMap points at the box).
        // (#3329) DEFERRED (stored) callbacks get the same rebind: the callback
        // fires from a LATER host call, and a SIBLING stored callback capturing
        // the same local must alias ONE cell — without the rebind each creation
        // minted its own cell and the last writeback won (`body += chunk` in a
        // "data" listener was invisible to the "end" listener: the #1795 http
        // Tier 0 shape, and the #1794 multi-listener shape). After the rebind
        // the sibling's capture analysis sees the local as already-boxed and
        // pushes the SAME cell.
        if (needsThis || options?.deferredInvocation === true) {
          fctx.localMap.set(cap.name, refCellLocal);
          (fctx.boxedCaptures ??= new Map()).set(cap.name, { refCellTypeIdx, valType: cap.type });
        }
      } else {
        // Immutable capture or already-boxed: push directly
        if (process.env?.JS2WASM_FRAME_OPS) {
          const liveFrame = fctx.params.length + fctx.locals.length;
          if (cap.localIdx >= liveFrame) {
            process.stderr.write(
              `[js2:cap-emit] '${cap.name}' localIdx=${cap.localIdx} >= liveFrame=${liveFrame} ` +
                `(params=${fctx.params.length} locals=${fctx.locals.length}) in ${fctx.name} ` +
                `mapNow=${fctx.localMap.get(cap.name)} alreadyBoxed=${cap.alreadyBoxed}\n`,
            );
          }
        }
        fctx.body.push({ op: "local.get", index: cap.localIdx });
      }
    }
    fctx.body.push({ op: "struct.new", typeIdx: capStructTypeIdx });
    fctx.body.push({ op: "extern.convert_any" });

    // Register writeback instructions for mutable captures (#859, #929).
    // After the host call returns, read ref cell values back into outer locals.
    // For getter/setter callbacks (needsThis=true), the callback may be stored
    // and invoked later by a different host call, so we use persistent writebacks
    // that re-sync after every subsequent call expression.
    if (refCellLocals.length > 0) {
      const writebacks: Instr[] = [];
      for (const rc of refCellLocals) {
        // (#2128) Null-guard the cell: writebacks are re-emitted at sites that
        // may execute while the creation site (e.g. inside an untaken branch)
        // hasn't run, leaving refCellLocal null — skip instead of trapping.
        writebacks.push({ op: "local.get", index: rc.refCellLocal });
        writebacks.push({ op: "ref.is_null" });
        writebacks.push({ op: "i32.eqz" });
        writebacks.push({
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: rc.refCellLocal },
            { op: "ref.as_non_null" },
            { op: "struct.get", typeIdx: rc.refCellTypeIdx, fieldIdx: 0 },
            { op: "local.set", index: rc.outerLocalIdx },
          ],
          else: [],
        });
      }
      // (#1695) Promote to persistent for stored-callback host methods too:
      // defer/use/adopt only register the callback, the actual invocation
      // happens later inside dispose(). A one-shot pending writeback would
      // snapshot the pre-invocation ref-cell value into the outer local.
      const usePersistent = needsThis || options?.deferredInvocation === true;
      if (usePersistent) {
        // Persistent: re-emit after every call, since the callback may be
        // invoked by a later host call (getter/setter, defer/use/adopt + dispose).
        if (!fctx.persistentCallbackWritebacks) fctx.persistentCallbackWritebacks = [];
        fctx.persistentCallbackWritebacks.push(...writebacks);
      } else {
        if (!fctx.pendingCallbackWritebacks) fctx.pendingCallbackWritebacks = [];
        fctx.pendingCallbackWritebacks.push(...writebacks);
      }
    }
  } else {
    fctx.body.push({ op: "ref.null.extern" });
  }

  fctx.body.push({ op: "call", funcIdx: makeCallbackIdx });
  return { kind: "externref" };
}

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Check if a function body references the `arguments` identifier.
 * Skips nested function declarations and function expressions (which have
 * their own `arguments` binding), but traverses into arrow functions
 * because arrows inherit the enclosing function's `arguments`.
 */
function closureBodyUsesArguments(node: ts.Node): boolean {
  if (ts.isIdentifier(node) && node.text === "arguments") return true;
  if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) {
    return false;
  }
  // Arrow functions do NOT have their own `arguments` — they inherit
  // the enclosing function's, so we must traverse into them.
  return forEachChild(node, closureBodyUsesArguments) ?? false;
}

// ── Registration ──────────────────────────────────────────────────────
// Register compileArrowAsClosure in the shared module so other modules
// can call it without a direct import cycle.
registerCompileArrowAsClosure(compileArrowAsClosure);
