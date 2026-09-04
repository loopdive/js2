// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#3278) Arrow / function-expression closure PHASE helpers, extracted from the
 * ~1.3k-LOC god-function `compileArrowAsClosure` in `../closures.ts` (WAVE B
 * code-bloat-elimination, subtask of #3182). Behaviour-preserving verbatim
 * lift — the emitted-Wasm byte-identity oracle (scripts/prove-emit-identity.mjs)
 * proves these produce IDENTICAL output.
 *
 *   - planClosureCaptures    — phase 1: capture analysis (free-var scan, boxing)
 *   - mintClosureStructTypes — phase 2: capture-struct + lifted-func type minting
 *
 * A short module-cycle with `../closures.ts` (it imports these back) is safe:
 * every cross-module binding is used only inside function bodies, which run long
 * after module initialization.
 */
import { ts, forEachChild } from "../../ts-api.js";
import type { ClosureInfo, CodegenContext, FunctionContext } from "../context/types.js";
import type { Instr, ValType } from "../../ir/types.js";
import { addFuncType, destructureParamArray, destructureParamObject, getOrRegisterRefCellType } from "../index.js";
import { addFunctionOwnLocals } from "../../ir/analysis/binding-info.js";
import { isFunctionScopeBoundary } from "../../ir/analysis/ast-scope.js";
import {
  closureArityField,
  closureBagField,
  closureBagInitInstr,
  getOrCreateConstructibleFuncRefWrapperTypes,
  getOrCreateFuncRefWrapperTypes,
} from "./funcref-wrapper-types.js";
import { allocLocal, getLocalType } from "../context/locals.js";
import { closureObservesBindingValue, collectTransitiveCaptureNames } from "../function-declaration-observation.js";
import { valTypesMatch } from "../shared.js";
import { tryEmitNativeIteratorResultParam } from "../promise-native-iterator-result.js";
import { materializeHoistedFunctionValueBinding } from "./funcref-as-closure.js";
import { bodyReferencesOwnThis } from "../helpers/body-references-own-this.js";
// (#4437) per-declaration `name` / §15.1.5 `length` carrier
import { ensureFnMetaSubtype, fnMetaSlot, registerFnMetaFamily } from "../function-instance-meta.js";
// (#4440) object-literal accessors / methods — §10.2.9 comes from the property key
import { fnMetaSlotForMemberDecl } from "../function-instance-meta-methods.js";
import {
  arrowOwnLocals,
  buildCaptureFieldDef,
  closureProvablyAfterLetDecl,
  closureNameResolvesToImportBinding,
  collectBindingPatternNames,
  collectOverBody,
  collectParamDefaultReferences,
  collectReferencedIdentifiers,
  collectWrittenIdentifiers,
  genBodyReferencesSuper,
  isOwnParamName,
  runtimeParameters,
} from "../closures.js";

export type ArrowClosureCapture = {
  name: string;
  type: ValType;
  localIdx: number;
  mutable: boolean;
  alreadyBoxed: boolean;
  /**
   * #1177: whether this capture's TDZ flag must be propagated through the
   * closure (forces value-boxing too — see planClosureCaptures).
   */
  hasTdzFlag: boolean;
  /**
   * The closure is constructed in a potentially-skipped top-level body and
   * captures a source binding whose box can safely be initialized in the
   * dominating parent buffer immediately before that body.
   */
  eagerDominatingBox: boolean;
};

function assignmentTargetWritesName(target: ts.Node, name: string): boolean {
  if (ts.isIdentifier(target)) return target.text === name;
  if (ts.isBindingElement(target)) return assignmentTargetWritesName(target.name, name);
  if (ts.isArrayBindingPattern(target) || ts.isObjectBindingPattern(target)) {
    return target.elements.some((element) => assignmentTargetWritesName(element, name));
  }
  if (
    ts.isParenthesizedExpression(target) ||
    ts.isAsExpression(target) ||
    ts.isNonNullExpression(target) ||
    ts.isTypeAssertionExpression(target)
  ) {
    return assignmentTargetWritesName(target.expression, name);
  }
  if (ts.isArrayLiteralExpression(target)) {
    return target.elements.some((element) => {
      if (ts.isOmittedExpression(element)) return false;
      return assignmentTargetWritesName(ts.isSpreadElement(element) ? element.expression : element, name);
    });
  }
  if (ts.isObjectLiteralExpression(target)) {
    return target.properties.some((property) => {
      if (ts.isShorthandPropertyAssignment(property)) return property.name.text === name;
      if (ts.isPropertyAssignment(property)) return assignmentTargetWritesName(property.initializer, name);
      if (ts.isSpreadAssignment(property)) return assignmentTargetWritesName(property.expression, name);
      return false;
    });
  }
  return false;
}

function bindingWrittenBeforeClosure(
  root: ts.Node,
  closure: ts.ArrowFunction | ts.FunctionExpression,
  name: string,
): boolean {
  const closureStart = closure.getStart();
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found || node === closure) return;
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      node.left.getStart() < closureStart &&
      assignmentTargetWritesName(node.left, name)
    ) {
      found = true;
      return;
    }
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) &&
      node.operand.getStart() < closureStart &&
      assignmentTargetWritesName(node.operand, name)
    ) {
      found = true;
      return;
    }
    if (
      (ts.isForInStatement(node) || ts.isForOfStatement(node)) &&
      node.initializer.getStart() < closureStart &&
      (ts.isVariableDeclarationList(node.initializer)
        ? node.initializer.declarations.some((declaration) => assignmentTargetWritesName(declaration.name, name))
        : assignmentTargetWritesName(node.initializer, name))
    ) {
      found = true;
      return;
    }
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer !== undefined &&
      node.name.getStart() < closureStart &&
      assignmentTargetWritesName(node.name, name)
    ) {
      found = true;
      return;
    }
    forEachChild(node, visit);
  };
  visit(root);
  return found;
}

function directInitializedLocalBeforeRegion(
  body: ts.Block,
  region: ts.Node,
  name: string,
): ts.VariableDeclaration | undefined {
  for (const statement of body.statements) {
    if (statement === region) break;
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name && declaration.initializer) {
        return declaration;
      }
    }
  }
  return undefined;
}

/**
 * (#2118 mirror) The binding name a `const f = (…) => …` / `let f = …` arrow
 * refers to itself by. Inside the lifted body that name resolves to `__self`
 * (lifted param 0), not to any declared parameter — the same predicate
 * `collectArrowCaptures` uses to route the recursive call.
 */
function selfRecursiveArrowBindingName(owner: ts.Node): string | undefined {
  if (!ts.isArrowFunction(owner) && !(ts.isFunctionExpression(owner) && !owner.name)) return undefined;
  const declaration = owner.parent;
  if (
    declaration &&
    ts.isVariableDeclaration(declaration) &&
    declaration.initializer === owner &&
    ts.isIdentifier(declaration.name)
  ) {
    return declaration.name.text;
  }
  return undefined;
}

function canBoxBindingInDominatingParent(
  fctx: FunctionContext,
  closure: ts.ArrowFunction | ts.FunctionExpression,
  name: string,
  localIdx: number,
): boolean {
  const entryBody = fctx.activationEntryBody;
  if (
    !entryBody ||
    fctx.body === entryBody ||
    fctx.sourceFunctionStrict === false ||
    fctx.savedBodies.length === 0 ||
    fctx.savedBodies[0] !== entryBody
  ) {
    return false;
  }

  let owner: ts.Node | undefined = closure.parent;
  while (owner && !ts.isFunctionLike(owner)) owner = owner.parent;
  if (!owner || ts.isSourceFile(owner)) return false;
  const ownerBody = (owner as ts.FunctionLikeDeclarationBase).body;
  if (!ownerBody || !ts.isBlock(ownerBody)) return false;
  let region: ts.Node = closure;
  while (region.parent && region.parent !== ownerBody) region = region.parent;
  if (region.parent !== ownerBody) return false;

  const sourceParameter = owner.parameters.find(
    (parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === name,
  );
  const safeSourceParameter =
    localIdx < fctx.params.length && sourceParameter !== undefined && sourceParameter.initializer === undefined;
  const safeInitializedLocal =
    localIdx >= fctx.params.length && directInitializedLocalBeforeRegion(ownerBody, region, name) !== undefined;
  // (#2118) The self-recursive arrow binding resolves to `__self`, lifted param
  // 0 — always live at entry and never written. It has no entry in
  // `owner.parameters` (the name belongs to the OUTER binding), so the
  // parameter test cannot see it, and the local test rejects it for being a
  // param. Without this a nested closure that captures the recursion boxes it
  // inside whichever conditional arm happens to construct that closure first,
  // and every LATER recursive reference is re-aimed at that box — reading null
  // on any path that skipped the arm. Source order alone then decides whether
  // the function traps.
  // `localIdx === 0` alone is NOT proof: in a body that was not lifted, slot 0
  // is the arrow's own FIRST PARAMETER, and boxing that instead of the
  // recursion is a miscompile (measured: jest's `test.concurrent.each` fixture
  // went 3/3 → 0/3). Require the synthetic self param by NAME.
  const safeSelfBinding =
    localIdx === 0 && fctx.params[0]?.name === "__self" && selfRecursiveArrowBindingName(owner) === name;
  if (!safeSourceParameter && !safeInitializedLocal && !safeSelfBinding) return false;

  // The parent buffer already contains every preceding top-level statement,
  // so writes before `region` are reflected in the value we box there. Refuse
  // only when the detached region itself writes the parameter before closure
  // construction; those writes were already emitted against the raw slot.
  return !bindingWrittenBeforeClosure(region, closure, name);
}

/** A closure created directly while an enclosing function's parameter
 * environment is being initialized cannot see declarations from that
 * function's body VariableEnvironment yet. A same-named live local therefore
 * wins over an eagerly registered body-function entry in `funcMap`. */
function isDirectParameterInitializerClosure(node: ts.ArrowFunction | ts.FunctionExpression): boolean {
  let child: ts.Node = node;
  for (let parent = node.parent; parent; child = parent, parent = parent.parent) {
    if (ts.isParameter(parent)) return parent.initializer === child;
    if (ts.isFunctionLike(parent)) return false;
  }
  return false;
}

/**
 * A live parameter/capture parameter in the enclosing Wasm frame is a lexical
 * binding. It wins over any same-named funcMap entry while inheriting captures
 * and selecting the value to capture. Redux's returned bindActionCreator
 * function is the untyped-JS package shape.
 */
function isEnclosingParameterBinding(fctx: FunctionContext, name: string): boolean {
  const localIdx = fctx.localMap.get(name);
  return localIdx !== undefined && localIdx < fctx.params.length;
}

/**
 * Whether an inner closure is nested below a function parameter binding with
 * this spelling.  The checker can temporarily resolve a nested reference to
 * a same-named module function while the linked multi-source pass is filling
 * funcMap; the enclosing parameter is still the lexical runtime binding.
 */
function hasEnclosingParameterBinding(arrow: ts.ArrowFunction | ts.FunctionExpression, name: string): boolean {
  for (let node = arrow.parent; node && !ts.isSourceFile(node); node = node.parent) {
    if (!isFunctionScopeBoundary(node)) continue;
    const parameters = (node as ts.SignatureDeclaration).parameters;
    for (const parameter of parameters ?? []) {
      if (ts.isIdentifier(parameter.name) && parameter.name.text === name) return true;
      if (ts.isObjectBindingPattern(parameter.name) || ts.isArrayBindingPattern(parameter.name)) {
        const names = new Set<string>();
        collectBindingPatternNames(parameter.name, names);
        if (names.has(name)) return true;
      }
    }
  }
  return false;
}

function isCaptureValueReference(id: ts.Identifier): boolean {
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
}

function declarationIsInsideClosure(declaration: ts.Declaration, closure: ts.Node): boolean {
  for (let node: ts.Node | undefined = declaration; node !== undefined; node = node.parent) {
    if (node === closure) return true;
    if (ts.isSourceFile(node)) return false;
  }
  return false;
}

/**
 * The legacy name collector deliberately excludes block-scoped declarations
 * from its function-wide shadow set. That preserves a genuine outer reference
 * beside an inner `{ let x }`, but it also means an inner-only `for (let i)`
 * is initially reported as free. Use checker identity to remove the latter
 * only when every real use resolves to a declaration inside this closure.
 */
function hasReferenceOutsideClosure(ctx: CodegenContext, closure: ts.Node, name: string): boolean {
  let sawReference = false;
  let sawOuterReference = false;
  const visit = (node: ts.Node): void => {
    if (sawOuterReference) return;
    if (ts.isIdentifier(node) && node.text === name && isCaptureValueReference(node)) {
      sawReference = true;
      const declaration = ctx.oracle.valueDeclarationOf(node);
      // Unknown identity stays conservative: it may be an imported/global or
      // dynamically supplied binding, so retain the capture candidate.
      if (!declaration || !declarationIsInsideClosure(declaration, closure)) {
        sawOuterReference = true;
        return;
      }
    }
    forEachChild(node, visit);
  };
  visit(closure);
  return !sawReference || sawOuterReference;
}

/** Resolve a closure's free reference by declaration identity, not spelling. */
function referencedBindingDeclaration(
  ctx: CodegenContext,
  closure: ts.ArrowFunction | ts.FunctionExpression,
  name: string,
): ts.Declaration | undefined {
  let declaration: ts.Declaration | undefined;
  let ambiguous = false;
  const visit = (node: ts.Node): void => {
    if (ambiguous) return;
    if (node !== closure && ts.isFunctionLike(node)) return;
    if (ts.isIdentifier(node) && node.text === name && isCaptureValueReference(node)) {
      const resolved = ctx.oracle.valueDeclarationOf(node);
      if (!resolved || (declaration !== undefined && declaration !== resolved)) {
        ambiguous = true;
        return;
      }
      declaration = resolved;
    }
    forEachChild(node, visit);
  };
  visit(closure);
  return ambiguous ? undefined : declaration;
}

/**
 * True when a declaration is owned directly by an emitted TypeScript
 * namespace/module block rather than by a nested function inside it.
 * Runtime-namespace bindings have dedicated module globals and must remain
 * live when an arrow created during namespace initialization observes a later
 * assignment (the TypeScript parser's lazily initialized constructors are the
 * production witness).
 */
function isDirectRuntimeModuleVariableBinding(declaration: ts.Declaration | undefined): boolean {
  if (declaration === undefined) return false;
  let sawVariableDeclaration = false;
  for (let current: ts.Node | undefined = declaration; current?.parent; current = current.parent) {
    if (ts.isVariableDeclaration(current)) sawVariableDeclaration = true;
    if (ts.isModuleBlock(current.parent)) return sawVariableDeclaration;
    if (current !== declaration && (ts.isFunctionLike(current) || ts.isClassLike(current))) return false;
    if (ts.isSourceFile(current.parent)) return false;
  }
  return false;
}

function removeClosureOwnedBlockBindingCollisions(
  ctx: CodegenContext,
  fctx: FunctionContext,
  closure: ts.Node,
  ownLocals: ReadonlySet<string>,
  referencedNames: Set<string>,
): void {
  for (const name of [...referencedNames]) {
    if (ownLocals.has(name) || !fctx.localMap.has(name)) continue;
    if (!hasReferenceOutsideClosure(ctx, closure, name)) referencedNames.delete(name);
  }
}

function collectClosureParameterReferences(
  arrow: ts.ArrowFunction | ts.FunctionExpression,
  referencedNames: Set<string>,
  ownLocals: ReadonlySet<string>,
): void {
  collectParamDefaultReferences(arrow.parameters, referencedNames, ownLocals);
  for (const parameter of arrow.parameters) collectReferencedIdentifiers(parameter, referencedNames, ownLocals);
}

/**
 * True when evaluating `closure` is part of evaluating the initializer that
 * will later store the captured binding's first value.
 *
 * `var scanner = { self: () => scanner }` is observably a live binding, even
 * when no later assignment exists: the closure is constructed while
 * `scanner` still contains its hoisted `undefined`/null value, and the
 * declarator store happens only after the whole object literal completes.
 * Such a capture therefore needs the same ref-cell treatment as an explicit
 * outer assignment. Declaration identity comes from the checker; ancestry is
 * used only to establish the evaluation ordering within that declaration.
 */
function closurePrecedesBindingInitializerStore(
  closure: ts.ArrowFunction | ts.FunctionExpression,
  declaration: ts.Declaration | undefined,
): boolean {
  if (declaration === undefined || !ts.isVariableDeclaration(declaration) || declaration.initializer === undefined) {
    return false;
  }
  for (let current: ts.Node | undefined = closure; current && current !== declaration; current = current.parent) {
    if (current === declaration.initializer) return true;
    // A nested closure in another function's body is constructed only when
    // that outer function runs, not while the declarator evaluates. The outer
    // function value itself will independently capture this binding at the
    // actual initializer site.
    if (current !== closure && ts.isFunctionLike(current)) return false;
  }
  return false;
}

/**
 * Phase 1 of compileArrowAsClosure: capture analysis. Scans the arrow /
 * function-expression body (and its parameter default initializers) for free
 * variables, decides which must be boxed (written inside the closure, written
 * in the enclosing scope, or TDZ-flagged), and resolves each to its outer-scope
 * local slot + type. Also detects the self-recursive const/let binding routed
 * through `__self`.
 *
 * Pure analysis: the only side effect on the caller's `fctx` is seeding
 * `fctx.tdzFlagLocals` for names whose TDZ slot was recovered by the #1177
 * block-scope-shadow rescan — preserved because `fctx` is passed by reference.
 */
export function planClosureCaptures(
  ctx: CodegenContext,
  fctx: FunctionContext,
  arrow: ts.ArrowFunction | ts.FunctionExpression,
  body: ts.ConciseBody,
  additionalCaptureNames?: Iterable<string>,
): { captures: ArrowClosureCapture[]; selfBindingName: string | undefined } {
  // 2. Analyze captured variables. Use scope-aware collection so that nested
  //    `var` declarations and parameter bindings inside the closure body shadow
  //    outer references — otherwise a closure with its own `var i;` would be
  //    treated as capturing the outer `i` (#995/#996).
  const ownLocals = arrowOwnLocals(arrow);
  const createdInParameterEnvironment = isDirectParameterInitializerClosure(arrow);

  // (#2118) Self-recursive const/let arrow: `const f = (n) => ... f(n-1)`.
  // The closure references its own binding `f`. Without special handling the
  // binding is captured as an ordinary variable; but the outer slot for `f` is
  // typed `externref` (function types resolve to externref) and is still
  // uninitialized at the moment the closure is constructed, so the capture is
  // boxed into a `__ref_cell_externref` and the construction path emits an
  // invalid `ref.cast` between the ref-cell struct and the closure struct
  // (struct.get type-mismatch validation failure). Detect the self-binding and
  // route the self-reference through `__self` (lifted param 0) — exactly the
  // mechanism named function expressions already use — so the recursive call
  // dispatches through the closure's own struct and the name is NOT captured.
  let selfBindingName: string | undefined;
  if (ts.isArrowFunction(arrow) || (ts.isFunctionExpression(arrow) && !arrow.name)) {
    const declParent = arrow.parent;
    if (
      declParent &&
      ts.isVariableDeclaration(declParent) &&
      declParent.initializer === arrow &&
      ts.isIdentifier(declParent.name)
    ) {
      selfBindingName = declParent.name.text;
    }
  }

  const referencedNames = new Set<string>();
  collectOverBody(collectReferencedIdentifiers, body, referencedNames, ownLocals);
  // (#3096) Free variables referenced ONLY in a parameter default initializer
  // — or in a binding-pattern element default / computed key — must be
  // captured too. The body scan above misses them, so a default like
  // `([x] = iter) => {}` (where `iter` is an outer var referenced nowhere in
  // the body) never captured `iter`; the default then compiled to `ref.null`,
  // and array destructuring threw "Cannot destructure null/undefined". Scan
  // `param.name` (catches binding-pattern element defaults + computed keys) and
  // `param.initializer` (top-level param default) with the same own-locals
  // shadow set, so the param's own binding names stay excluded.
  collectClosureParameterReferences(arrow, referencedNames, ownLocals);

  // Arrow functions do not introduce a `this` binding.  `this` is not an
  // identifier, so the free-variable scan above intentionally cannot see it;
  // without an explicit capture, the lifted body falls through to
  // `__current_this` (or the unbound value) instead of retaining the receiver
  // from its enclosing constructor/method.  Keep ordinary function
  // expressions on their existing own-`this` path, and only add the synthetic
  // capture when the enclosing frame actually has a receiver local.
  if (
    ts.isArrowFunction(arrow) &&
    fctx.localMap.has("this") &&
    (bodyReferencesOwnThis(body) || genBodyReferencesSuper(body))
  ) {
    referencedNames.add("this");
  }

  // (#3040) Parameter DEFAULT initializers can reference enclosing-scope names
  // that appear NOWHERE in the body — e.g. `f = async function*([x] = iter)`
  // where `iter` is an outer local used ONLY in the default. The body-only scan
  // above misses them, so such a name is never captured and the lifted
  // default-init reads a null local, which then destructures to "Cannot
  // destructure null". This is the function-expression / arrow twin of the
  // FunctionDeclaration fix in statements/nested-declarations.ts (the async-gen /
  // gen / fn EXPRESSION variants of the `ary-init-iter-close` cluster lower here,
  // not through the declaration path). Scan each parameter subtree (its
  // `= <default>` initializer AND nested binding-pattern element defaults like
  // `[x = outer]`) with `ownLocals` as the shadow set so the destructured binding
  // names and earlier params stay local while free references in the defaults
  // become captures. Placed BEFORE the transitive-capture loop so a default that
  // calls a capturing nested function also pulls in that function's transitive
  // captures.
  removeClosureOwnedBlockBindingCollisions(ctx, fctx, arrow, ownLocals, referencedNames);
  // Imported bindings remain live views of module storage. Never snapshot one
  // into a closure capture merely because the module-initializer frame also
  // carries a same-named staging local.
  for (const name of [...referencedNames]) {
    if (
      (ctx.moduleGlobals.has(name) || ctx.funcMap.has(name) || ctx.closureMap.has(name)) &&
      closureNameResolvesToImportBinding(ctx, arrow, name)
    ) {
      referencedNames.delete(name);
    }
  }
  // Direct-eval source is opaque to the static identifier scan. Its lexical
  // ancestors have already promoted all eval-visible bindings to cells; make
  // those cells explicit captures so this closure can forward the live scope.
  if (additionalCaptureNames) {
    for (const name of additionalCaptureNames) {
      if (!ownLocals.has(name)) referencedNames.add(name);
    }
  }

  // Transitively add captures needed by called nested functions.
  // E.g. if this closure calls g() and g has nestedFuncCaptures {first, second},
  // this closure must also capture first and second so it can pass ref cells to g.
  const transitivelyRequiredNames = collectTransitiveCaptureNames(
    ctx.nestedFuncCaptures,
    referencedNames,
    ownLocals,
    (name) => isEnclosingParameterBinding(fctx, name),
  );

  // Detect which captured variables are written inside the closure body
  const writtenInClosure = new Set<string>();
  collectOverBody(collectWrittenIdentifiers, body, writtenInClosure, ownLocals);
  // (#3040) Symmetric with the referencedNames scan above: a param default that
  // ASSIGNS an outer var (rare, e.g. `[x] = (outer = 5, [outer])`) must keep that
  // capture boxed rather than snapshotted.
  for (const p of arrow.parameters) {
    collectWrittenIdentifiers(p, writtenInClosure, ownLocals);
  }

  // Also detect variables written in the enclosing scope (not just the closure).
  // If the outer function writes to a captured variable, the capture must use a
  // ref cell so the closure sees the updated value.
  // We use the TS checker to find all write references to the variable's symbol.
  // A variable needs boxing if it has any assignment outside the closure body.
  const writtenInOuter = new Set<string>();
  for (const name of referencedNames) {
    if (writtenInClosure.has(name)) continue; // Already mutable, no need to check
    try {
      // Find the symbol for this variable
      const sym = ctx.checker.getSymbolAtLocation(ts.isBlock(body) ? (body.statements[0] ?? body) : body);
      // Use the enclosing function body to find all writes to this name.
      // (#3128) Walk PAST function nodes the call-site inliner flattened into
      // this fctx (`fctx.inlinedIifeNodes`): an inlined IIFE is not a real
      // scope boundary in the emitted Wasm — its "locals" live in fctx's
      // frame, so writes to the captured name in the REAL enclosing body
      // (e.g. `p2 = (function(){ return () => p2; })()`) must count as outer
      // writes. Stopping at the erased boundary made the capture by-value:
      // a stale copy the outer assignment never reached.
      //
      // Shadow guard: only walk past an inlined IIFE that does NOT itself
      // declare `name` (params / own function-scoped decls). If it does, the
      // capture refers to the IIFE's OWN binding — an outer same-named write
      // targets a DIFFERENT variable and must not force-box the shadow
      // (`var x=1; (function(){ var x=5; return ()=>x; })(); x=2;` — the
      // closure must keep seeing 5).
      const iifeDeclaresName = (fn: ts.Node): boolean => {
        const own = new Set<string>();
        addFunctionOwnLocals(fn, own);
        return own.has(name);
      };
      let enclosing: ts.Node | undefined = arrow.parent;
      while (
        enclosing &&
        (!(
          ts.isFunctionDeclaration(enclosing) ||
          ts.isFunctionExpression(enclosing) ||
          ts.isArrowFunction(enclosing) ||
          ts.isMethodDeclaration(enclosing) ||
          ts.isConstructorDeclaration(enclosing) ||
          ts.isSourceFile(enclosing)
        ) ||
          ((fctx.inlinedIifeNodes?.has(enclosing) ?? false) && !iifeDeclaresName(enclosing)))
      ) {
        enclosing = enclosing.parent;
      }
      if (enclosing) {
        const outerBody = ts.isSourceFile(enclosing) ? enclosing : (enclosing as any).body;
        if (outerBody) {
          // Collect writes in the outer body, excluding the closure body itself
          const outerWrites = new Set<string>();
          const collectOuterWrites = (node: ts.Node): void => {
            // Skip the closure body itself
            if (node === arrow) return;
            // Check for assignments
            if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
              if (ts.isIdentifier(node.left) && node.left.text === name) {
                outerWrites.add(name);
              }
            }
            if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
              if (ts.isIdentifier(node.operand) && node.operand.text === name) {
                outerWrites.add(name);
              }
            }
            // Compound assignments (+=, -=, etc.)
            if (
              ts.isBinaryExpression(node) &&
              node.operatorToken.kind >= ts.SyntaxKind.PlusEqualsToken &&
              node.operatorToken.kind <= ts.SyntaxKind.CaretEqualsToken
            ) {
              if (ts.isIdentifier(node.left) && node.left.text === name) {
                outerWrites.add(name);
              }
            }
            forEachChild(node, collectOuterWrites);
          };
          if (ts.isBlock(outerBody)) {
            for (const stmt of outerBody.statements) {
              collectOuterWrites(stmt);
            }
          } else {
            collectOuterWrites(outerBody);
          }
          if (outerWrites.has(name)) {
            writtenInOuter.add(name);
          }
        }
      }
    } catch {
      // If analysis fails, be conservative — don't add to writtenInOuter
    }
  }

  const captures: {
    name: string;
    type: ValType;
    localIdx: number;
    mutable: boolean;
    alreadyBoxed: boolean;
    /**
     * #1177: Whether this capture's TDZ flag must be propagated through the
     * closure. Set when `fctx.tdzFlagLocals?.has(name)` at capture-analysis time.
     * Forces value-boxing too — the value at construction time may be the default
     * (uninit), so the closure must see post-init mutations through the ref cell.
     */
    hasTdzFlag: boolean;
    eagerDominatingBox: boolean;
  }[] = [];
  for (const name of referencedNames) {
    let localIdx = fctx.localMap.get(name);
    // The ordinary-function lexical-this path materializes a private local
    // without changing the frame's normal `this` binding (see closures.ts).
    if (localIdx === undefined && name === "this") localIdx = fctx.lexicalThisCaptureLocal;
    let tdzFlagIdxFromScan: number | undefined;
    if (localIdx === undefined) {
      // (#3121) A localMap miss can ALSO mean the name was PROMOTED to a
      // module global by `promoteAccessorCapturesToGlobals` (an earlier
      // object-literal method/accessor in this function captured it). The
      // promotion deliberately deleted the localMap entry so every later
      // reference — including this closure's body — resolves through the
      // promoted global (identifiers.ts/assignment.ts check
      // `ctx.capturedBoxGlobals`/`ctx.capturedGlobals` on a localMap miss).
      // The #1177 rescan below would resurrect the ORPHANED local slot and
      // box it into a fresh ref cell — a second store the method's
      // global-routed writes never reach (write via `__captured_c` global,
      // read via the stale cell → silent wrong results). Skip the capture:
      // the lifted body then shares the method's store via the global.
      if (fctx.promotedCaptureNames?.has(name)) continue;
      // #1177: The block-scope shadow manager (saveBlockScopedShadows) deletes
      // localMap entries for block-scoped let/const names that were pre-hoisted
      // by hoistLetConstWithTdz. Inside the block, before the let-decl runs,
      // the slot still exists in fctx.locals — find it by name. This restores
      // the ability of closures constructed inside the block to capture the
      // hoisted slot, which is essential for TDZ-through-closure to fire.
      for (let i = 0; i < fctx.locals.length; i++) {
        const slot = fctx.locals[i]!;
        if (slot.name === name) {
          localIdx = fctx.params.length + i;
          break;
        }
      }
    }
    if (localIdx === undefined) continue;
    const bindingDeclaration = referencedBindingDeclaration(ctx, arrow, name);
    // A runtime namespace initializer is compiled in the shared module-init
    // frame, whose staging locals can have the same spelling as both the
    // namespace slot and an unrelated top-level binding. Capturing that local
    // snapshots the hoisted null value. The exact namespace projection in
    // `ctx.moduleGlobals` is active for this whole closure compilation, so
    // leave the name uncaptured and let the lifted body read that live global.
    if (ctx.moduleGlobals.has(name) && isDirectRuntimeModuleVariableBinding(bindingDeclaration)) continue;
    // A lexical capture can share its spelling with a function declaration
    // already registered in funcMap (for example `{ dispatch }` beside a
    // module-local `dispatch`).  The old spelling-only guard dropped every
    // non-variable declaration here, including binding elements that resolve
    // to an enclosing parameter.  Keep the fast path only when checker
    // identity proves that this reference is the mapped function itself.
    const mappedFunctionDeclaration = ctx.funcMapOwnerDecl.get(name) ?? ctx.topLevelFunctionDeclarations.get(name);
    const hasEnclosingParam = hasEnclosingParameterBinding(arrow, name);
    // #2669: skip names bound to a *user* function (a function reference, not a
    // captured variable) — but NOT a wasm:js-string builtin import
    // (concat/length/equals/substring/charCodeAt), which lives in funcMap yet
    // must not block capture of a same-named outer local (e.g. the test262
    // `let length = "outer"` dstr template). Discriminate by index.
    if (
      !createdInParameterEnvironment &&
      localIdx >= fctx.params.length &&
      ctx.funcMap.has(name) &&
      ctx.funcMap.get(name) !== ctx.jsStringImports.get(name) &&
      !hasEnclosingParam &&
      (bindingDeclaration === undefined || bindingDeclaration === mappedFunctionDeclaration) &&
      !transitivelyRequiredNames.has(name) &&
      (!fctx.hoistedFunctionValueBindings?.has(name) || !closureObservesBindingValue(arrow, name))
    ) {
      continue;
    }
    // Skip if the name is the arrow's own parameter (including destructuring bindings)
    if (isOwnParamName(arrow, name)) continue;
    // Skip if the name is a named function expression's own name (self-reference)
    if (ts.isFunctionExpression(arrow) && arrow.name && arrow.name.text === name) continue;
    // (#2118) Skip the self-recursive const/let arrow binding — routed via __self.
    if (selfBindingName !== undefined && name === selfBindingName) continue;
    // #1177: Also fall back to scanning for a `__tdz_<name>` slot when
    // tdzFlagLocals was cleared by block-scope shadow management.
    if (!fctx.tdzFlagLocals?.has(name)) {
      const tdzSlotName = `__tdz_${name}`;
      for (let i = 0; i < fctx.locals.length; i++) {
        if (fctx.locals[i]!.name === tdzSlotName) {
          tdzFlagIdxFromScan = fctx.params.length + i;
          break;
        }
      }
    }
    const type =
      localIdx < fctx.params.length
        ? fctx.params[localIdx]!.type
        : (fctx.locals[localIdx - fctx.params.length]?.type ?? { kind: "f64" });
    // A capture is mutable if the closure writes to it OR the outer scope writes to it.
    // Both cases require a ref cell so mutations are visible across scope boundaries.
    // #1177: Also force-box when the variable has a TDZ flag — the captured value
    // at construction time may be the uninitialized default (e.g. `let x` declared
    // after the closure is built), so post-init mutations must flow through the
    // ref cell for the closure to observe them.
    //
    // BUT: only force-box if the closure is in a position where TDZ is actually
    // possible. For for-let-iter where the closure is inside the loop body (and
    // the let-decl is the for-init), the variable is initialized BEFORE every
    // iteration's closure construction. Force-boxing breaks per-iteration
    // semantics: each iteration would share the same box (single Wasm slot),
    // so all closures see the final value of the loop variable.
    const tdzFlagPresent = !!fctx.tdzFlagLocals?.has(name) || tdzFlagIdxFromScan !== undefined;
    const hasTdzFlag = tdzFlagPresent && !closureProvablyAfterLetDecl(ctx, arrow, name);
    const initializerStoreFollowsCapture = closurePrecedesBindingInitializerStore(arrow, bindingDeclaration);
    const isMutable =
      writtenInClosure.has(name) || writtenInOuter.has(name) || hasTdzFlag || initializerStoreFollowsCapture;
    // Check if the variable is already boxed from a previous closure capture.
    // If so, the local already holds a ref cell — don't wrap it again.
    const alreadyBoxed = !!fctx.boxedCaptures?.has(name);
    const eagerDominatingBox =
      isMutable && !alreadyBoxed && canBoxBindingInDominatingParent(fctx, arrow, name, localIdx);
    // #1177: If we found the TDZ flag via fctx.locals scan (block-scope shadow
    // cleared tdzFlagLocals), seed fctx.tdzFlagLocals so downstream emit code
    // (including the construction-time emit below and the call-site TDZ check)
    // routes through the boxed flag mechanism.
    if (tdzFlagIdxFromScan !== undefined) {
      if (!fctx.tdzFlagLocals) fctx.tdzFlagLocals = new Map();
      if (!fctx.tdzFlagLocals.has(name)) fctx.tdzFlagLocals.set(name, tdzFlagIdxFromScan);
    }
    captures.push({ name, type, localIdx, mutable: isMutable, alreadyBoxed, hasTdzFlag, eagerDominatingBox });
  }

  return { captures, selfBindingName };
}

/**
 * Phase 2 of compileArrowAsClosure: capture-struct type minting. Builds the
 * closure struct type (field 0 = funcref, fields 1..N = capture values, then
 * TDZ-flag ref-cell fields) and the lifted function type. No-capture /
 * non-named closures reuse the shared funcref-wrapper struct; captured closures
 * become a subtype of it so call-site `ref.cast` succeeds. Returns the struct /
 * func type indices and the lifted parameter list.
 */
interface ClosureStructMintOptions {
  captures: ArrowClosureCapture[];
  arrowParams: ValType[];
  closureResults: ValType[];
  closureName: string;
  isNamedFuncExpr: boolean;
  constructible: boolean;
  /** (#4437) The arrow / function expression itself, for the `$fnmeta` slot. */
  decl?: ts.Node;
}

/**
 * Publish a capturing rest closure's subtype before its lifted body compiles.
 * A reduce callback can feed an earlier instance of this same closure back
 * into that body; nominal registration distinguishes its positional call from
 * a genuine one-vec-parameter closure with the same funcref signature.
 */
function registerCapturingRestClosureDuringBodyCompilation(
  ctx: CodegenContext,
  opts: ClosureStructMintOptions,
  structTypeIdx: number,
  liftedFuncTypeIdx: number,
): void {
  const { captures, arrowParams, closureResults, decl } = opts;
  const returnType = closureResults.length === 1 ? closureResults[0]! : null;
  if (
    captures.length === 0 ||
    decl === undefined ||
    (!ts.isArrowFunction(decl) && !ts.isFunctionExpression(decl)) ||
    !runtimeParameters(decl).some((param) => param.dotDotDotToken !== undefined) ||
    returnType?.kind !== "externref"
  ) {
    return;
  }
  ctx.closureInfoByTypeIdx.set(structTypeIdx, {
    structTypeIdx,
    funcTypeIdx: liftedFuncTypeIdx,
    returnType,
    paramTypes: arrowParams,
    hasCaptures: true,
    hasRestParam: true,
    needsCallSiteArity: true,
  });
}

export function mintClosureStructTypes(
  ctx: CodegenContext,
  opts: ClosureStructMintOptions,
): {
  structTypeIdx: number;
  liftedFuncTypeIdx: number;
  liftedSelfTypeIdx: number;
  liftedParams: ValType[];
  /**
   * (#4437) The type to `struct.new` and the `$fnmeta` operand, when this
   * closure carries metadata.
   *
   * For a CAPTURE-carrying closure this equals `structTypeIdx` — that struct is
   * already per-closure, so the slot grows in place and no type identity
   * changes. For a capture-free closure the wrapper is SHARED across every
   * closure of the signature, so the slot needs a per-base subtype; the
   * reported `structTypeIdx` deliberately stays the BASE, because that is the
   * type every other site casts to and a cast to a MORE derived type traps on a
   * value stored as the base (see `emitCachedFuncClosureExternref`'s note).
   */
  meta?: { allocTypeIdx: number; init: Instr[] };
} {
  const { captures, arrowParams, closureResults, closureName, isNamedFuncExpr, constructible } = opts;
  // (#4440) An object-literal accessor/method reaches this mint site as its
  // OWN declaration node (`literals.ts` casts a `Get/SetAccessorDeclaration` to
  // `FunctionExpression` for the closure compile). `fnMetaSlot` declines those —
  // §10.2.9 for an accessor is `"get p"` / `"set p"`, which comes from the
  // property KEY, not from a function name. The member walk answers it.
  //
  // (#5149 cluster B) The member walk runs FIRST for a member declaration.
  // `fnInstanceMetaOf` accepts a `MethodDeclaration` and answers `""` for it —
  // §10.2.9 for a method comes from the property KEY, which only the member
  // walk reads — so the old `fnMetaSlot ?? member` order published that empty
  // name and never consulted the member walk at all. Measured on
  // `{ id() {} }` reached through the open-object literal path: the descriptor
  // `Object.getOwnPropertyDescriptor(o.id, "name").value` read `""` while the
  // static `.name` fold answered `"id"` — one function, two answers.
  const metaSlot = fnMetaSlotForMemberDecl(ctx, opts.decl) ?? fnMetaSlot(ctx, opts.decl);
  let structTypeIdx: number;
  let liftedFuncTypeIdx: number;
  let liftedSelfTypeIdx: number;
  let liftedParams: ValType[];
  if (captures.length === 0 && !isNamedFuncExpr) {
    const wrapperTypes = constructible
      ? getOrCreateConstructibleFuncRefWrapperTypes(ctx, arrowParams, closureResults)
      : getOrCreateFuncRefWrapperTypes(ctx, arrowParams, closureResults);
    if (wrapperTypes) {
      structTypeIdx = wrapperTypes.structTypeIdx;
      liftedFuncTypeIdx = wrapperTypes.liftedFuncTypeIdx;
      liftedSelfTypeIdx = wrapperTypes.liftedSelfTypeIdx;
      liftedParams = [{ kind: "ref", typeIdx: liftedSelfTypeIdx }, ...arrowParams];
      // (#4437) Shared wrapper ⇒ the metadata slot needs a per-base subtype.
      const allocTypeIdx = metaSlot ? ensureFnMetaSubtype(ctx, structTypeIdx) : undefined;
      if (metaSlot && allocTypeIdx !== undefined) {
        return {
          structTypeIdx,
          liftedFuncTypeIdx,
          liftedSelfTypeIdx,
          liftedParams,
          meta: { allocTypeIdx, init: metaSlot.init },
        };
      }
    } else {
      // Fallback: create a unique struct type
      const structFields = [
        { name: "func", type: { kind: "funcref" as const }, mutable: false },
        closureArityField(),
        closureBagField(),
      ];
      structTypeIdx = ctx.mod.types.length;
      ctx.mod.types.push({
        kind: "struct",
        name: `${closureName}_struct`,
        fields: structFields,
      });
      liftedSelfTypeIdx = structTypeIdx;
      liftedParams = [{ kind: "ref", typeIdx: liftedSelfTypeIdx }, ...arrowParams];
      liftedFuncTypeIdx = addFuncType(ctx, liftedParams, closureResults, `${closureName}_type`);
    }
  } else {
    const structFields = [
      { name: "func", type: { kind: "funcref" as const }, mutable: false },
      closureArityField(),
      closureBagField(),
      ...captures.map((c) => buildCaptureFieldDef(ctx, c)),
    ];

    // #1177: Append a TDZ-flag ref-cell field for every capture that carries
    // a TDZ flag in the outer fctx. The flag is shared by reference so the
    // outer scope and the closure observe the same initialization status.
    // Field layout: [funcref, ...value_fields, ...tdz_flag_fields].
    const tdzFlaggedCaptures = captures.filter((c) => c.hasTdzFlag);
    if (tdzFlaggedCaptures.length > 0) {
      const i32RefCellTypeIdx = getOrRegisterRefCellType(ctx, { kind: "i32" });
      for (const c of tdzFlaggedCaptures) {
        structFields.push({
          name: `__tdz_${c.name}`,
          type: { kind: "ref_null" as const, typeIdx: i32RefCellTypeIdx },
          mutable: false,
        });
      }
    }
    if (constructible) {
      structFields.push({ name: "__constructible", type: { kind: "i32" as const }, mutable: false });
    }
    // (#4437) A capture-carrying closure's struct is ALREADY per-closure, so
    // the slot is appended in place — last, after `__constructible`, matching
    // the operand order `emitClosureConstruction` pushes.
    if (metaSlot) structFields.push(metaSlot.field);

    // For closures with captures, make the struct a subtype of the shared
    // wrapper struct so ref.cast at call sites succeeds. Named func exprs need
    // ref_null __self (for var hoisting), so they can't share the wrapper's
    // lifted func type which uses non-null ref — but (#3673) they still
    // SUBTYPE the wrapper and take the nullable canonical ROOT as their self
    // param: their lifted func types then dedupe BY USER SIGNATURE across all
    // named function expressions (previously each minted a private
    // `(ref_null $ownStruct, …)` func type, and acorn's hundreds of
    // `pp$X.method = function …` closures exploded the `__apply_closure` /
    // `__call_fn_method_N` ref.test chains to ~90 arms). Bodies downcast the
    // root self to the private struct for capture access — the same
    // `usesWrapperFuncType` machinery shared-wrapper captured closures use.
    const wrapperTypes = getOrCreateFuncRefWrapperTypes(ctx, arrowParams, closureResults);

    structTypeIdx = ctx.mod.types.length;
    if (wrapperTypes && isNamedFuncExpr) {
      ctx.mod.types.push({
        kind: "struct",
        name: `${closureName}_struct`,
        fields: structFields,
        superTypeIdx: wrapperTypes.structTypeIdx,
      });
      if (constructible) ctx.constructibleClosureTypeIdxs.add(structTypeIdx);
      liftedSelfTypeIdx = wrapperTypes.liftedSelfTypeIdx;
      liftedParams = [{ kind: "ref_null", typeIdx: liftedSelfTypeIdx }, ...arrowParams];
      liftedFuncTypeIdx = addFuncType(ctx, liftedParams, closureResults, `${closureName}_type`);
    } else if (wrapperTypes) {
      // Subtype of the wrapper struct — inherits field 0 (funcref), adds captures
      ctx.mod.types.push({
        kind: "struct",
        name: `${closureName}_struct`,
        fields: structFields,
        superTypeIdx: wrapperTypes.structTypeIdx,
      });
      if (constructible) ctx.constructibleClosureTypeIdxs.add(structTypeIdx);
      // Share the wrapper's lifted func type so call_ref dispatches correctly.
      // The __self param is the canonical wrapper ROOT, and the lifted body
      // ref.casts to the specific subtype to access captures.
      liftedFuncTypeIdx = wrapperTypes.liftedFuncTypeIdx;
      liftedSelfTypeIdx = wrapperTypes.liftedSelfTypeIdx;
      liftedParams = [{ kind: "ref", typeIdx: liftedSelfTypeIdx }, ...arrowParams];
    } else {
      ctx.mod.types.push({
        kind: "struct",
        name: `${closureName}_struct`,
        fields: structFields,
      });
      if (constructible) ctx.constructibleClosureTypeIdxs.add(structTypeIdx);
      // 4. Create the lifted function type: (ref_null $closure_struct, ...arrowParams) → results
      // Use ref_null for __self so that var-hoisted variables shadowing the function name
      // (e.g. `var g` inside `function g()`) can be default-initialized to null.
      liftedSelfTypeIdx = structTypeIdx;
      liftedParams = [{ kind: "ref_null", typeIdx: liftedSelfTypeIdx }, ...arrowParams];
      liftedFuncTypeIdx = addFuncType(ctx, liftedParams, closureResults, `${closureName}_type`);
    }
  }
  // The ordinary post-body registration replaces this provisional entry with
  // the complete ClosureInfo.
  registerCapturingRestClosureDuringBodyCompilation(ctx, opts, structTypeIdx, liftedFuncTypeIdx);
  if (metaSlot) {
    // Registered here rather than at each mint branch so every path that grew
    // the field also gets its family arm — the slot is always LAST, so its
    // index is the struct's field count minus one.
    const fields = ctx.mod.types[structTypeIdx];
    if (fields?.kind === "struct" && fields.fields[fields.fields.length - 1]?.name === metaSlot.field.name) {
      registerFnMetaFamily(ctx, structTypeIdx, fields.fields.length - 1);
      return {
        structTypeIdx,
        liftedFuncTypeIdx,
        liftedSelfTypeIdx,
        liftedParams,
        meta: { allocTypeIdx: structTypeIdx, init: metaSlot.init },
      };
    }
  }
  return { structTypeIdx, liftedFuncTypeIdx, liftedSelfTypeIdx, liftedParams };
}

/**
 * Phase 4 of compileArrowAsClosure: destructuring-parameter initialization for
 * binding-pattern params (`function([x, y])` / `function({a, b})`). Delegates
 * to the shared destructuring implementations (array / tuple-struct / object /
 * externref-host) so defaults, nested patterns, rest elements and
 * ReferenceError-on-unresolvable-default behave uniformly with function
 * declarations. Emits into `liftedFctx.body`.
 */
export function emitClosureParamDestructuring(
  ctx: CodegenContext,
  liftedFctx: FunctionContext,
  arrow: ts.ArrowFunction | ts.FunctionExpression,
  arrowParams: ValType[],
): void {
  // Destructuring parameter initialization: for parameters with binding patterns
  // (e.g. function([x, y]) or function({a, b})), extract values from the parameter
  // and assign them to local variables. Delegate to the shared destructuring
  // implementations (same as function declarations) so that default initializers,
  // nested patterns, rest elements, and ReferenceError-on-unresolvable defaults
  // all work uniformly across function declarations, function expressions, and
  // arrow functions (#ref-error-A).
  // (#3359) Over the this-param-stripped list so `pi` aligns with `arrowParams`.
  const destructureParams = runtimeParameters(arrow);
  for (let pi = 0; pi < destructureParams.length; pi++) {
    const param = destructureParams[pi]!;
    if (ts.isIdentifier(param.name)) continue; // simple param, already handled

    const paramIdx = pi + 1; // +1 for __self
    const paramType = arrowParams[pi]!;

    // Keep closure parameter binding-patterns on the same shared lowering as
    // declarations and ordinary function bodies.  The old closure-only
    // struct/vec extractors handled identifiers, but skipped nested patterns
    // and their default initializers (for example `[{x} = fallback]`), which
    // left those bindings at their zero/null local defaults.  The shared
    // helpers already select the native carrier and preserve the required
    // undefined/null checks for every ABI type.
    if (ts.isArrayBindingPattern(param.name)) {
      destructureParamArray(ctx, liftedFctx, paramIdx, param.name, paramType);
      continue;
    }
    if (ts.isObjectBindingPattern(param.name)) {
      if (tryEmitNativeIteratorResultParam(ctx, liftedFctx, paramIdx, param.name, paramType)) continue;
      destructureParamObject(ctx, liftedFctx, paramIdx, param.name, paramType);
    }
  }
}

/**
 * Phase 6a of compileArrowAsClosure: construction-site emit. At the closure's
 * creation site (in the ENCLOSING `fctx.body`) push `ref.func` + each capture
 * value (boxing mutable captures into ref cells, re-aiming the outer local),
 * then the TDZ-flag ref cells, then `struct.new` the closure struct.
 */
function findUnboxedCaptureLocal(
  fctx: FunctionContext,
  name: string,
  boxedLocalIdx: number,
  valueType: ValType,
): number | undefined {
  for (let localOffset = 0; localOffset < fctx.locals.length; localOffset++) {
    const localIdx = fctx.params.length + localOffset;
    if (localIdx === boxedLocalIdx) continue;
    const local = fctx.locals[localOffset];
    if (local?.name === name && valTypesMatch(local.type, valueType)) return localIdx;
  }
  return undefined;
}

/**
 * Push a live capture cell, repairing a nullable cell which was allocated by
 * an earlier conditional closure site but did not execute on this path. The
 * cell itself is the shared identity used by all later closures; only its
 * first value comes from the original unboxed slot. This keeps lazy closure
 * construction safe without snapshotting a mutable binding into a fresh cell.
 */
function pushCaptureCell(ctx: CodegenContext, fctx: FunctionContext, cap: ArrowClosureCapture): void {
  const boxed = fctx.boxedCaptures?.get(cap.name);
  // A recursive sibling can materialize this binding while an outer closure's
  // construction is still walking its capture list. That promotion updates
  // `boxedCaptures` and `localMap`, but the capture descriptor's `localIdx`
  // was computed before the promotion and still names the raw value slot.
  // Prefer the live mapped cell only when its type agrees with the box; keep
  // the descriptor slot for ordinary captures and stale-map cases.
  const mappedLocalIdx = fctx.localMap.get(cap.name);
  const mappedType = mappedLocalIdx === undefined ? undefined : getLocalType(fctx, mappedLocalIdx);
  const mappedIsCell =
    boxed !== undefined &&
    mappedType !== undefined &&
    (mappedType.kind === "ref" || mappedType.kind === "ref_null") &&
    mappedType.typeIdx === boxed.refCellTypeIdx;
  const boxedLocalIdx = mappedIsCell ? mappedLocalIdx! : cap.localIdx;
  const boxedType = getLocalType(fctx, boxedLocalIdx);
  const valueType = boxed?.valType;
  const rawLocalIdx = valueType ? findUnboxedCaptureLocal(fctx, cap.name, boxedLocalIdx, valueType) : undefined;
  const nullableBox =
    boxed !== undefined &&
    valueType !== undefined &&
    (boxedType?.kind === "ref" || boxedType?.kind === "ref_null") &&
    boxedType.typeIdx === boxed.refCellTypeIdx &&
    rawLocalIdx !== undefined;
  if (!nullableBox) {
    fctx.body.push({ op: "local.get", index: boxedLocalIdx });
    return;
  }

  const refCellTypeIdx = boxed.refCellTypeIdx;
  fctx.body.push({ op: "local.get", index: boxedLocalIdx });
  fctx.body.push({ op: "ref.is_null" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "ref_null", typeIdx: refCellTypeIdx } },
    then: [
      { op: "local.get", index: rawLocalIdx },
      { op: "struct.new", typeIdx: refCellTypeIdx },
      { op: "local.tee", index: boxedLocalIdx },
    ],
    else: [{ op: "local.get", index: boxedLocalIdx }],
  });
}

export function emitClosureConstruction(
  ctx: CodegenContext,
  fctx: FunctionContext,
  captures: ArrowClosureCapture[],
  liftedFuncIdx: number,
  structTypeIdx: number,
  arity: number,
  /** (#4437) The `$fnmeta` operand + the type to allocate, from `mintClosureStructTypes`. */
  meta?: { allocTypeIdx: number; init: Instr[] },
): void {
  // A construction site in a conditional arm cannot own the canonical box for
  // a captured parameter: compilation re-aims all later reads to that box even
  // when the arm is skipped at runtime. Materialize proven-safe boxes in the
  // top-level parent buffer immediately before the conditional instruction.
  // Appending (rather than unshifting to function entry) preserves any writes
  // performed by preceding statements — Hono normalizes `path` before the
  // conditional callback that first captures it.
  for (const cap of captures) {
    if (!cap.eagerDominatingBox || fctx.boxedCaptures?.has(cap.name)) continue;
    const entryBody = fctx.activationEntryBody;
    if (!entryBody) continue;
    const refCellTypeIdx = getOrRegisterRefCellType(ctx, cap.type);
    const boxedLocalIdx = allocLocal(fctx, `__boxed_${cap.name}`, { kind: "ref", typeIdx: refCellTypeIdx });
    entryBody.push(
      { op: "local.get", index: cap.localIdx },
      { op: "struct.new", typeIdx: refCellTypeIdx },
      { op: "local.set", index: boxedLocalIdx },
    );
    cap.localIdx = boxedLocalIdx;
    fctx.localMap.set(cap.name, boxedLocalIdx);
    (fctx.boxedCaptures ??= new Map()).set(cap.name, { refCellTypeIdx, valType: cap.type });
  }

  // 7. At the creation site, emit struct.new with funcref + (#3673) declared
  // arity + captured values
  fctx.body.push({ op: "ref.func", funcIdx: liftedFuncIdx });
  fctx.body.push({ op: "i32.const", value: arity });
  fctx.body.push(closureBagInitInstr()); // (#4241) $bag — no expandos at birth
  for (const cap of captures) {
    // A transitive nested-call dependency can require a sibling declaration's
    // Function value even when this closure never names it directly. Fill the
    // hoisted binding before the closure snapshots/passes its slot; otherwise
    // the lifted caller receives the preallocated null value.
    materializeHoistedFunctionValueBinding(ctx, fctx, cap.name, cap.mutable !== true);
    if (cap.mutable) {
      // Check if the outer scope already has this variable boxed (nested closure case)
      if (fctx.boxedCaptures?.has(cap.name)) {
        // Already a ref cell — pass the shared cell reference directly. If a
        // conditional closure site allocated the nullable cell but did not
        // execute, lazily repair that same cell from the raw binding.
        pushCaptureCell(ctx, fctx, cap);
      } else {
        // Wrap the current value in a ref cell
        const refCellTypeIdx = getOrRegisterRefCellType(ctx, cap.type);
        fctx.body.push({ op: "local.get", index: cap.localIdx });
        fctx.body.push({ op: "struct.new", typeIdx: refCellTypeIdx });
        // Also box the outer local so subsequent reads/writes go through the ref cell
        const boxedLocalIdx = allocLocal(fctx, `__boxed_${cap.name}`, { kind: "ref_null", typeIdx: refCellTypeIdx });
        // Duplicate: we need the ref cell for the closure struct AND for the outer local
        fctx.body.push({ op: "local.tee", index: boxedLocalIdx });
        // Re-register the original name to point to the boxed local
        fctx.localMap.set(cap.name, boxedLocalIdx);
        if (!fctx.boxedCaptures) fctx.boxedCaptures = new Map();
        fctx.boxedCaptures.set(cap.name, { refCellTypeIdx, valType: cap.type });
      }
    } else {
      if (cap.alreadyBoxed && fctx.boxedCaptures?.has(cap.name)) {
        pushCaptureCell(ctx, fctx, cap);
      } else {
        fctx.body.push({ op: "local.get", index: cap.localIdx });
      }
    }
  }

  // #1177: After all value fields, push the boxed TDZ flag refs (one per
  // TDZ-flagged capture). For freshly captured flags, allocate the box now
  // and re-aim the outer fctx's `tdzFlagLocals` + `boxedTdzFlags` so
  // subsequent set/get of the flag in the outer scope routes through the
  // same ref cell that the closure holds.
  {
    const tdzFlaggedCapturesAtConstruct = captures.filter((c) => c.hasTdzFlag);
    if (tdzFlaggedCapturesAtConstruct.length > 0) {
      const i32RefCellTypeIdx = getOrRegisterRefCellType(ctx, { kind: "i32" });
      for (const cap of tdzFlaggedCapturesAtConstruct) {
        const existingBox = fctx.boxedTdzFlags?.get(cap.name);
        if (existingBox) {
          // Already boxed by an enclosing closure construction — reuse.
          fctx.body.push({ op: "local.get", index: existingBox.localIdx });
        } else {
          // Fresh box: read current i32 flag, struct.new an i32 ref cell,
          // tee into a new outer-fctx local, and re-aim the flag entry.
          const oldFlagIdx = fctx.tdzFlagLocals!.get(cap.name)!;
          fctx.body.push({ op: "local.get", index: oldFlagIdx });
          fctx.body.push({ op: "struct.new", typeIdx: i32RefCellTypeIdx });
          const flagBoxLocal = allocLocal(fctx, `__tdz_box_${cap.name}`, {
            kind: "ref_null",
            typeIdx: i32RefCellTypeIdx,
          });
          fctx.body.push({ op: "local.tee", index: flagBoxLocal });
          if (!fctx.boxedTdzFlags) fctx.boxedTdzFlags = new Map();
          fctx.boxedTdzFlags.set(cap.name, { refCellTypeIdx: i32RefCellTypeIdx, localIdx: flagBoxLocal });
          // Re-aim tdzFlagLocals so subsequent emitLocalTdzInit/Check in
          // fctx routes through the boxed path (set/get flag in ref cell).
          fctx.tdzFlagLocals!.set(cap.name, flagBoxLocal);
        }
      }
    }
  }

  if (ctx.constructibleClosureTypeIdxs.has(structTypeIdx)) {
    fctx.body.push({ op: "i32.const", value: 1 });
  }

  if (meta) for (const instr of meta.init) fctx.body.push(instr);
  fctx.body.push({ op: "struct.new", typeIdx: meta ? meta.allocTypeIdx : structTypeIdx });
}

/**
 * Phase 6b of compileArrowAsClosure: closure-info registration. Register the
 * `ClosureInfo` by struct type index (for valueOf coercion / anonymous closures)
 * and, when the closure is bound to a variable / assigned to a local or module
 * global, in `ctx.closureMap` so call sites emit `call_ref`.
 */
export function registerClosureBindingInfo(
  ctx: CodegenContext,
  arrow: ts.ArrowFunction | ts.FunctionExpression,
  structTypeIdx: number,
  liftedFuncTypeIdx: number,
  closureReturnType: ValType | null,
  arrowParams: ValType[],
  inlineBody?: Instr[],
): void {
  const params = runtimeParameters(arrow);
  const usesOwnArguments =
    ts.isFunctionExpression(arrow) && ts.isBlock(arrow.body) && closureBodyUsesOwnArguments(arrow.body);
  // 8. Register closure info so call sites can emit call_ref
  const structDef = ctx.mod.types[structTypeIdx];
  const inheritedInfo = ctx.closureInfoByTypeIdx.get(structTypeIdx);
  const closureInfo: ClosureInfo = {
    structTypeIdx,
    funcTypeIdx: liftedFuncTypeIdx,
    returnType: closureReturnType,
    paramTypes: arrowParams,
    minimumArgumentCount:
      ctx.closureMinimumArgumentCountByFuncTypeIdx.get(liftedFuncTypeIdx) ?? inheritedInfo?.minimumArgumentCount,
    hasCaptures: structDef?.kind === "struct" && structDef.fields.length > 1,
    hasRestParam: params.some((p) => p.dotDotDotToken !== undefined),
    needsCallSiteArity:
      usesOwnArguments || params.some((p) => p.dotDotDotToken !== undefined || p.initializer !== undefined),
    inlineBody,
  };

  // Always register by struct type index (for valueOf coercion and anonymous closures)
  ctx.closureInfoByTypeIdx.set(structTypeIdx, closureInfo);

  const parent = arrow.parent;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    ctx.closureMap.set(parent.name.text, closureInfo);
  } else if (
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isIdentifier(parent.left)
  ) {
    // Assignment expression: f = function() { ... }
    // Register if the target variable is a local in the current function context
    // (not a boxed capture) OR a module-level global variable (#852).
    const assignName = parent.left.text;
    const currentFctx = ctx.currentFunc!;
    const localIdx = currentFctx.localMap.get(assignName);
    if (localIdx !== undefined && !currentFctx.boxedCaptures?.has(assignName)) {
      // It's a local variable (not a boxed capture) — safe to register as closure
      ctx.closureMap.set(assignName, closureInfo);
    } else if (ctx.moduleGlobals.has(assignName)) {
      // Module-level global: `var f; f = () => {...}` — register for closure dispatch
      ctx.closureMap.set(assignName, closureInfo);
    }
  } else if (ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) {
    // Object literal: { fn: function() { ... } }
    // Don't register in closureMap (property, not variable)
  }
}

/** Whether a function expression's own `arguments` binding is observable. */
function closureBodyUsesOwnArguments(node: ts.Node): boolean {
  if (ts.isIdentifier(node) && node.text === "arguments") return true;
  if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) return false;
  // Nested arrows inherit the function expression's `arguments` binding.
  return forEachChild(node, closureBodyUsesOwnArguments) ?? false;
}
