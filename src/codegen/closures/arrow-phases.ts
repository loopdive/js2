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
import {
  addFuncType,
  destructureParamArray,
  destructureParamObjectExternref,
  getArrTypeIdxFromVec,
  getOrRegisterRefCellType,
  resolveWasmType,
} from "../index.js";
import { addFunctionOwnLocals } from "../../ir/analysis/binding-info.js";
import {
  closureArityField,
  closureBagField,
  closureBagInitInstr,
  getOrCreateConstructibleFuncRefWrapperTypes,
  getOrCreateFuncRefWrapperTypes,
} from "./funcref-wrapper-types.js";
import { allocLocal, getLocalType } from "../context/locals.js";
import { closureObservesBindingValue, collectTransitiveCaptureNames } from "../function-declaration-observation.js";
import { emitBoundsCheckedArrayGet, valTypesMatch } from "../shared.js";
import { spliceNullGuarded } from "./param-emit-helpers.js";
import { materializeHoistedFunctionValueBinding } from "./funcref-as-closure.js";
// (#4437) per-declaration `name` / §15.1.5 `length` carrier
import { ensureFnMetaSubtype, fnMetaSlot, registerFnMetaFamily } from "../function-instance-meta.js";
// (#4440) object-literal accessors / methods — §10.2.9 comes from the property key
import { fnMetaSlotForMemberDecl } from "../function-instance-meta-methods.js";
import {
  arrowOwnLocals,
  buildCaptureFieldDef,
  closureProvablyAfterLetDecl,
  closureNameResolvesToImportBinding,
  collectOverBody,
  collectParamDefaultReferences,
  collectReferencedIdentifiers,
  collectWrittenIdentifiers,
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
  if (!safeSourceParameter && !safeInitializedLocal) return false;

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
      (bindingDeclaration === undefined || !ts.isVariableDeclaration(bindingDeclaration)) &&
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
    const isMutable = writtenInClosure.has(name) || writtenInOuter.has(name) || hasTdzFlag;
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
export function mintClosureStructTypes(
  ctx: CodegenContext,
  opts: {
    captures: ArrowClosureCapture[];
    arrowParams: ValType[];
    closureResults: ValType[];
    closureName: string;
    isNamedFuncExpr: boolean;
    constructible: boolean;
    /** (#4437) The arrow / function expression itself, for the `$fnmeta` slot. */
    decl?: ts.Node;
  },
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
  const metaSlot = fnMetaSlot(ctx, opts.decl) ?? fnMetaSlotForMemberDecl(ctx, opts.decl);
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
  // Fallback: allocate externref locals for each name in a binding pattern.
  // Used when the param type doesn't match any known struct/vec — locals are
  // initialized to null/undefined (best-effort; the type is unknown at compile time).
  function allocBindingLocals(pattern: ts.BindingPattern): void {
    for (const element of pattern.elements) {
      if (ts.isOmittedExpression(element)) continue;
      if (!ts.isBindingElement(element)) continue;
      if (ts.isIdentifier(element.name)) {
        allocLocal(liftedFctx, element.name.text, { kind: "externref" });
      } else {
        allocBindingLocals(element.name);
      }
    }
  }

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

    // Helper: allocate locals for all identifiers in a binding pattern
    // using TS type inference for each element. Fallback used when the
    // Wasm type doesn't provide enough info to extract values.
    const allocBindingLocals = (pattern: ts.BindingPattern) => {
      for (const element of pattern.elements) {
        if (ts.isOmittedExpression(element)) continue;
        if (ts.isIdentifier(element.name)) {
          const localName = element.name.text;
          if (!liftedFctx.localMap.has(localName)) {
            const elemTsType = ctx.checker.getTypeAtLocation(element);
            const elemWasmType = resolveWasmType(ctx, elemTsType);
            allocLocal(liftedFctx, localName, elemWasmType);
          }
        } else if (ts.isObjectBindingPattern(element.name) || ts.isArrayBindingPattern(element.name)) {
          allocBindingLocals(element.name);
        }
      }
    };

    if (ts.isArrayBindingPattern(param.name)) {
      // Array destructuring: function([a, b, c]) { ... }
      let handled = false;

      // For externref params (e.g. typed as `any`), delegate to destructureParamArray
      // which handles multi-type vec conversion with ref.test guards.
      // A bare ref.cast to a single vec type (e.g. __vec_f64) will trap at runtime
      // if the actual value is a different vec type (e.g. __vec_externref from []).
      if (paramType.kind === "externref") {
        destructureParamArray(ctx, liftedFctx, paramIdx, param.name, paramType);
        handled = true;
      }

      let resolvedParamType = paramType;
      let srcParamIdx = paramIdx;
      if (!handled && (paramType.kind === "ref" || paramType.kind === "ref_null")) {
        resolvedParamType = paramType;
        srcParamIdx = paramIdx;
      }

      if (resolvedParamType.kind === "ref" || resolvedParamType.kind === "ref_null") {
        const typeIdx = resolvedParamType.typeIdx;
        const typeDef = ctx.mod.types[typeIdx];
        if (typeDef && typeDef.kind === "struct") {
          const arrTypeIdx = getArrTypeIdxFromVec(ctx, typeIdx);
          const arrDef = ctx.mod.types[arrTypeIdx];
          if (arrDef && arrDef.kind === "array") {
            const elemType = arrDef.element;
            const savedBodyFPAD = liftedFctx.body;
            const fpadInstrs: Instr[] = [];
            liftedFctx.body = fpadInstrs;
            for (let ei = 0; ei < param.name.elements.length; ei++) {
              const element = param.name.elements[ei]!;
              if (ts.isOmittedExpression(element)) continue;
              if (!ts.isBindingElement(element)) continue;

              // Handle rest element: function([a, ...rest])
              if (element.dotDotDotToken && ts.isIdentifier(element.name)) {
                const restName = element.name.text;
                const restLenLocal = allocLocal(liftedFctx, `__rest_len_${liftedFctx.locals.length}`, { kind: "i32" });
                // Compute rest length: max(0, param.length - ei)
                liftedFctx.body.push({ op: "local.get", index: srcParamIdx });
                liftedFctx.body.push({ op: "struct.get", typeIdx, fieldIdx: 0 }); // length
                liftedFctx.body.push({ op: "i32.const", value: ei });
                liftedFctx.body.push({ op: "i32.sub" });
                liftedFctx.body.push({ op: "local.set", index: restLenLocal });
                // Clamp to 0 if negative
                liftedFctx.body.push({ op: "i32.const", value: 0 });
                liftedFctx.body.push({ op: "local.get", index: restLenLocal });
                liftedFctx.body.push({ op: "local.get", index: restLenLocal });
                liftedFctx.body.push({ op: "i32.const", value: 0 });
                liftedFctx.body.push({ op: "i32.lt_s" });
                liftedFctx.body.push({ op: "select" });
                liftedFctx.body.push({ op: "local.set", index: restLenLocal });

                // Create new data array
                const restArrLocal = allocLocal(liftedFctx, `__rest_arr_${liftedFctx.locals.length}`, {
                  kind: "ref",
                  typeIdx: arrTypeIdx,
                });
                liftedFctx.body.push({ op: "local.get", index: restLenLocal });
                liftedFctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
                liftedFctx.body.push({ op: "local.set", index: restArrLocal });

                // array.copy(restArr, 0, srcData, ei, restLen)
                liftedFctx.body.push({ op: "local.get", index: restArrLocal });
                liftedFctx.body.push({ op: "i32.const", value: 0 });
                liftedFctx.body.push({ op: "local.get", index: srcParamIdx });
                liftedFctx.body.push({ op: "struct.get", typeIdx, fieldIdx: 1 }); // src data
                liftedFctx.body.push({ op: "i32.const", value: ei });
                liftedFctx.body.push({ op: "local.get", index: restLenLocal });
                liftedFctx.body.push({ op: "array.copy", dstTypeIdx: arrTypeIdx, srcTypeIdx: arrTypeIdx });

                // Create new vec struct: struct.new(restLen, restArr)
                liftedFctx.body.push({ op: "local.get", index: restLenLocal });
                liftedFctx.body.push({ op: "local.get", index: restArrLocal });
                liftedFctx.body.push({ op: "struct.new", typeIdx });

                const vecType: ValType = { kind: "ref_null", typeIdx };
                const restLocal = allocLocal(liftedFctx, restName, vecType);
                liftedFctx.body.push({ op: "local.set", index: restLocal });
                continue;
              }

              if (!ts.isIdentifier(element.name)) continue;
              const localName = element.name.text;
              const localIdx = allocLocal(liftedFctx, localName, elemType);
              liftedFctx.body.push({ op: "local.get", index: srcParamIdx });
              liftedFctx.body.push({ op: "struct.get", typeIdx, fieldIdx: 1 });
              liftedFctx.body.push({ op: "i32.const", value: ei });
              emitBoundsCheckedArrayGet(liftedFctx, arrTypeIdx, elemType);
              liftedFctx.body.push({ op: "local.set", index: localIdx });
            }
            liftedFctx.body = savedBodyFPAD;
            spliceNullGuarded(liftedFctx, srcParamIdx, resolvedParamType.kind === "ref_null", fpadInstrs);
            handled = true;
          } else if (typeDef.fields.length > 0 && typeDef.fields[0]!.name === "_0") {
            // Tuple struct destructuring: extract positional fields via struct.get
            const savedBodyFPAD = liftedFctx.body;
            const fpadInstrs: Instr[] = [];
            liftedFctx.body = fpadInstrs;
            for (let ei = 0; ei < param.name.elements.length; ei++) {
              const element = param.name.elements[ei]!;
              if (ts.isOmittedExpression(element)) continue;
              if (!ts.isBindingElement(element)) continue;
              if (ei >= typeDef.fields.length) break;

              const fieldType = typeDef.fields[ei]!.type;
              if (!ts.isIdentifier(element.name)) continue;
              const localName = element.name.text;
              const localIdx = allocLocal(liftedFctx, localName, fieldType);
              liftedFctx.body.push({ op: "local.get", index: srcParamIdx });
              liftedFctx.body.push({ op: "struct.get", typeIdx, fieldIdx: ei });
              liftedFctx.body.push({ op: "local.set", index: localIdx });
            }
            liftedFctx.body = savedBodyFPAD;
            spliceNullGuarded(liftedFctx, srcParamIdx, resolvedParamType.kind === "ref_null", fpadInstrs);
            handled = true;
          }
        }
      }
      if (!handled) {
        allocBindingLocals(param.name);
      }
    } else if (ts.isObjectBindingPattern(param.name)) {
      // Object destructuring: function({a, b}) { ... }
      let handled = false;

      // Externref params (e.g. callback from JS host or `: any`-typed) need
      // the host-import-driven extraction path that mirrors the array case
      // above. Without this, the object pattern's binding locals get
      // allocated but never written, so any code reading w/x/y/z sees the
      // default-zero/null value of the local instead of the property pulled
      // off the argument object. (#43 cluster — function-expression dstr
      // on `any` params)
      if (paramType.kind === "externref") {
        destructureParamObjectExternref(ctx, liftedFctx, paramIdx, param.name);
        handled = true;
      }

      if (!handled && (paramType.kind === "ref" || paramType.kind === "ref_null")) {
        const typeIdx = paramType.typeIdx;
        const typeDef = ctx.mod.types[typeIdx];
        if (typeDef && typeDef.kind === "struct") {
          let allFound = true;
          const savedBodyFPOD = liftedFctx.body;
          const fpodInstrs: Instr[] = [];
          liftedFctx.body = fpodInstrs;
          for (const element of param.name.elements) {
            if (ts.isOmittedExpression(element)) continue;
            if (!ts.isIdentifier(element.name)) continue;
            const localName = element.name.text;
            const propName = element.propertyName
              ? ts.isIdentifier(element.propertyName)
                ? element.propertyName.text
                : localName
              : localName;
            const fieldIdx = typeDef.fields.findIndex((f: any) => f.name === propName);
            if (fieldIdx < 0) {
              allFound = false;
              continue;
            }
            const fieldType = typeDef.fields[fieldIdx]!.type;
            const localIdx = allocLocal(liftedFctx, localName, fieldType);
            liftedFctx.body.push({ op: "local.get", index: paramIdx });
            liftedFctx.body.push({ op: "struct.get", typeIdx, fieldIdx });
            liftedFctx.body.push({ op: "local.set", index: localIdx });
          }
          liftedFctx.body = savedBodyFPOD;
          spliceNullGuarded(liftedFctx, paramIdx, paramType.kind === "ref_null", fpodInstrs);
          handled = allFound;
        }
      }
      if (!handled) {
        allocBindingLocals(param.name);
      }
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
  const boxedLocalIdx = cap.localIdx;
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
    materializeHoistedFunctionValueBinding(ctx, fctx, cap.name);
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
  const closureInfo: ClosureInfo = {
    structTypeIdx,
    funcTypeIdx: liftedFuncTypeIdx,
    returnType: closureReturnType,
    paramTypes: arrowParams,
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
