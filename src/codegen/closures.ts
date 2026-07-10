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
import { classMemberFuncKey } from "./class-member-keys.js"; // (#1983) collision-free class-member funcMap keys
import { definedFuncAt, funcSignatureOf, mintDefinedFunc, pushDefinedFunc } from "./func-space.js"; // (#1916 S2 read chokepoint / S3b stable-regime minting)
import { inLiveShiftRange } from "../emit/resolve-layout.js"; // (#1916 S3b) manual import-shift must skip stable handles
import { addStringConstantGlobal } from "./registry/imports.js"; // (#2025)
import { stringConstantExternrefInstrs } from "./native-strings.js"; // (#2025)
import { noJsHost } from "./expressions/helpers.js"; // (#2025)
import { emitWasiErrorConstructor } from "./registry/error-types.js"; // (#2025)
import { popBody, pushBody } from "./context/bodies.js";
import { reportError } from "./context/errors.js";
import { reportSilentFallback } from "./fallback-telemetry.js";
import { resolveLiftedMethodThisStruct } from "./fnctor-escape-gate.js"; // (#2681/#2686 A3) lifted-method `this`→struct
import { allocLocal, allocTempLocal, getLocalType } from "./context/locals.js";
import type { ClosureInfo, CodegenContext, FunctionContext } from "./context/types.js";
import {
  addFuncType,
  destructureParamArray,
  destructureParamObject,
  destructureParamObjectExternref,
  ensureExnTag,
  ensureStructForType,
  getArrTypeIdxFromVec,
  getOrRegisterRefCellType,
  getOrRegisterVecType,
  hoistLetConstWithTdz,
  hoistVarDeclarations,
  nextModuleGlobalIdx,
  resolveWasmType,
} from "./index.js";
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
} from "./statements.js";
import { coercionInstrs, emitGuardedRefCast } from "./type-coercion.js";
import { buildDestructureNullThrow, isNullOrUndefinedLiteral } from "./destructuring-params.js";
import {
  cacheParamDefaultArgc,
  emitF64ParamSentinelCheck,
  emitArgumentsVecBody,
  emitParamDefaultArgMissingCheck,
  ensureCurrentThisGlobal,
  paramDefaultNeedsArgc,
} from "./statements/nested-declarations.js";
import { detectStringBuilders, type StringBuilderPresizeInfo } from "./string-builder.js";
import { addFunctionOwnLocals, registerOwnLocalsCollector } from "./binding-info.js"; // (#2103) shared, memoized per-function binding-info oracle
// (#2957 phase 2) arrow/fn-expr async activation. Imported LAST: `async-activation`
// pulls the `async-cps`/`async-frame` chain which imports back into `closures`
// (a cycle), so it must evaluate after this module's other deps are loaded to
// avoid perturbing the init order of the coercion-engine/string-ops chain.
import { planAsyncClosureActivation, emitAsyncClosureBody } from "./async-activation.js";
import { emitAsyncGenerator, isAsyncGenDriveCandidate } from "./async-frame.js"; // (#2865) async-gen fn-expr producer

// ── Arrow function callbacks ──────────────────────────────────────────

/** True for nodes that introduce a new function scope (params + body locals). */
function isFunctionScopeBoundary(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node)
  );
}

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
 * Collect names that are LOCALLY DECLARED inside a function-like node's scope.
 * Used to compute the shadow set for free-variable analysis.
 *
 * Includes:
 *   - parameter binding identifiers (function-scoped)
 *   - `var` declarations anywhere in the body (function-scoped)
 *   - top-level `function`/`class` declarations in the body
 *
 * Does NOT cross nested function boundaries.
 *
 * Conservatively excludes block-scoped `let`/`const` since they only shadow
 * within their block, and adding them to the function-wide shadow set would
 * incorrectly mask legitimate outer captures.
 */
export function collectFunctionOwnLocals(funcLike: ts.Node, out: Set<string>): void {
  if (!isFunctionScopeBoundary(funcLike)) return;
  const decl = funcLike as ts.SignatureDeclaration;
  // Params (including destructuring binding identifiers)
  if (decl.parameters) {
    for (const p of decl.parameters) {
      if (ts.isIdentifier(p.name)) {
        out.add(p.name.text);
      } else if (ts.isObjectBindingPattern(p.name) || ts.isArrayBindingPattern(p.name)) {
        collectBindingPatternNames(p.name, out);
      }
    }
  }
  // Body var/function/class decls. Concise arrow bodies are expressions — no decls.
  const body = (decl as { body?: ts.Node | undefined }).body;
  if (body && ts.isBlock(body)) {
    for (const stmt of body.statements) {
      collectVarAndTopLevelDecls(stmt, out, /*atTopLevel=*/ true);
    }
  }
}

// (#2103) Back the shared binding-info oracle with the own-locals collector
// above. Registered once at module load; the oracle memoizes per function node
// so the repeated per-scope-boundary calls inside the identifier walks below
// (and across all other lowerings) reuse a single computed set.
registerOwnLocalsCollector(collectFunctionOwnLocals);

/**
 * Recursively collect `var` declarations (function-scoped) and top-level
 * `function`/`class` declarations from a node tree, without crossing nested
 * function scope boundaries.
 */
function collectVarAndTopLevelDecls(node: ts.Node, out: Set<string>, atTopLevel: boolean): void {
  if (isFunctionScopeBoundary(node)) return; // do not cross
  if (ts.isVariableStatement(node)) {
    const isVar = !(node.declarationList.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const));
    if (isVar) {
      for (const d of node.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) out.add(d.name.text);
        else if (ts.isObjectBindingPattern(d.name) || ts.isArrayBindingPattern(d.name)) {
          collectBindingPatternNames(d.name, out);
        }
      }
    }
    // Initializers may contain nested functions — keep walking but we won't
    // descend into their bodies (boundary check above).
    for (const d of node.declarationList.declarations) {
      if (d.initializer) collectVarAndTopLevelDecls(d.initializer, out, false);
    }
    return;
  }
  if (ts.isForStatement(node) && node.initializer && ts.isVariableDeclarationList(node.initializer)) {
    const isVar = !(node.initializer.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const));
    if (isVar) {
      for (const d of node.initializer.declarations) {
        if (ts.isIdentifier(d.name)) out.add(d.name.text);
        else if (ts.isObjectBindingPattern(d.name) || ts.isArrayBindingPattern(d.name)) {
          collectBindingPatternNames(d.name, out);
        }
      }
    }
  }
  if ((ts.isForInStatement(node) || ts.isForOfStatement(node)) && ts.isVariableDeclarationList(node.initializer)) {
    const isVar = !(node.initializer.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const));
    if (isVar) {
      for (const d of node.initializer.declarations) {
        if (ts.isIdentifier(d.name)) out.add(d.name.text);
        else if (ts.isObjectBindingPattern(d.name) || ts.isArrayBindingPattern(d.name)) {
          collectBindingPatternNames(d.name, out);
        }
      }
    }
  }
  if (ts.isFunctionDeclaration(node) && node.name && atTopLevel) {
    out.add(node.name.text);
    return; // do not recurse into nested function body
  }
  if (ts.isClassDeclaration(node) && node.name && atTopLevel) {
    out.add(node.name.text);
    return;
  }
  forEachChild(node, (c) => collectVarAndTopLevelDecls(c, out, false));
}

/**
 * Collect all identifiers referenced in a node.
 *
 * If `shadowed` is provided, identifiers in that set are NOT collected. The
 * walker also detects nested function scopes and augments the shadow set with
 * each nested function's own locals so that references inside them to names
 * shadowed by nested var/param decls aren't incorrectly attributed to the
 * outer scope.
 *
 * Callers analyzing free variables of a function-like body should compute the
 * function's own locals via `collectFunctionOwnLocals` and pass them as the
 * initial `shadowed` set, since the walker enters the body without crossing
 * the boundary itself.
 */
export function collectReferencedIdentifiers(node: ts.Node, names: Set<string>, shadowed?: ReadonlySet<string>): void {
  if (ts.isIdentifier(node)) {
    if (!shadowed || !shadowed.has(node.text)) names.add(node.text);
    return;
  }
  // Track `this` keyword references so arrow functions can capture the
  // enclosing scope's `this` through the normal closure mechanism.
  if (node.kind === ts.SyntaxKind.ThisKeyword || node.kind === ts.SyntaxKind.SuperKeyword) {
    if (!shadowed || !shadowed.has("this")) names.add("this");
    return;
  }
  if (isFunctionScopeBoundary(node)) {
    // Augment shadow set with this nested function's own locals before
    // recursing into its body. Function/method names declared by nested
    // FunctionExpressions/ArrowFunctions don't leak out, so we don't add the
    // node's own name to the OUTER shadow set; we add it (the named func
    // expr's own name) to the inner shadow so self-references aren't treated
    // as outer captures.
    const merged = new Set<string>(shadowed ?? []);
    addFunctionOwnLocals(node, merged); // (#2103) memoized own-locals
    if (ts.isFunctionExpression(node) && node.name) merged.add(node.name.text);
    forEachChild(node, (child) => collectReferencedIdentifiers(child, names, merged));
    return;
  }
  forEachChild(node, (child) => collectReferencedIdentifiers(child, names, shadowed));
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
        fctx.body.push({ op: "struct.get", typeIdx: boxed.refCellTypeIdx, fieldIdx: 0 } as Instr);
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

/** Collect all identifier names from a binding pattern (destructuring parameter) */
export function collectBindingPatternNames(pattern: ts.BindingPattern, names: Set<string>): void {
  for (const element of pattern.elements) {
    if (ts.isOmittedExpression(element)) continue;
    if (ts.isIdentifier(element.name)) {
      names.add(element.name.text);
    } else if (ts.isObjectBindingPattern(element.name) || ts.isArrayBindingPattern(element.name)) {
      collectBindingPatternNames(element.name, names);
    }
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
      fctx.body.push({ op: "any.convert_extern" } as Instr);
      fctx.body.push({ op: "ref.test", typeIdx: structTypeIdx });
      fctx.body.push({ op: "local.set", index: testLocal });

      // Struct path (ref.test succeeded)
      const structRefType: ValType = { kind: "ref_null", typeIdx: structTypeIdx };
      const structPath = collectInstrs(fctx, () => {
        const convertedIdx = allocLocal(fctx, `__destr_ref_${fctx.locals.length}`, structRefType);
        fctx.body.push({ op: "local.get", index: paramIdx });
        fctx.body.push({ op: "any.convert_extern" } as Instr);
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
          const isUndefIdx = ensureLateImportShared(
            ctx,
            "__extern_is_undefined",
            [{ kind: "externref" }],
            [{ kind: "i32" }],
          );
          flushLateImportShiftsShared(ctx, fctx);
          if (isUndefIdx !== undefined) {
            fctx.body.push({ op: "call", funcIdx: isUndefIdx });
          } else {
            fctx.body.push({ op: "ref.is_null" } as Instr);
          }
          const savedBody = pushBody(fctx);
          compileExpression(ctx, fctx, element.initializer, fieldType);
          fctx.body.push({ op: "local.set", index: localIdx } as Instr);
          const thenInstrs = fctx.body;
          fctx.body = savedBody;
          fctx.body.push({
            op: "if",
            blockType: { kind: "empty" },
            then: thenInstrs,
            else: [{ op: "local.get", index: tmpField } as Instr, { op: "local.set", index: localIdx } as Instr],
          });
        } else if (fieldType.kind === "ref_null" || fieldType.kind === "ref") {
          const tmpField = allocLocal(fctx, `__dflt_${fctx.locals.length}`, fieldType);
          fctx.body.push({ op: "local.tee", index: tmpField });
          fctx.body.push({ op: "ref.is_null" } as Instr);
          const savedBody = pushBody(fctx);
          compileExpression(ctx, fctx, element.initializer, fieldType);
          fctx.body.push({ op: "local.set", index: localIdx } as Instr);
          const thenInstrs = fctx.body;
          fctx.body = savedBody;
          fctx.body.push({
            op: "if",
            blockType: { kind: "empty" },
            then: thenInstrs,
            else: [{ op: "local.get", index: tmpField } as Instr, { op: "local.set", index: localIdx } as Instr],
          });
        } else if (fieldType.kind === "f64") {
          const tmpField = allocLocal(fctx, `__dflt_${fctx.locals.length}`, fieldType);
          fctx.body.push({ op: "local.tee", index: tmpField });
          fctx.body.push({ op: "local.get", index: tmpField });
          fctx.body.push({ op: "f64.ne" });
          const savedBody = pushBody(fctx);
          compileExpression(ctx, fctx, element.initializer, fieldType);
          fctx.body.push({ op: "local.set", index: localIdx } as Instr);
          const thenInstrs = fctx.body;
          fctx.body = savedBody;
          fctx.body.push({
            op: "if",
            blockType: { kind: "empty" },
            then: thenInstrs,
            else: [{ op: "local.get", index: tmpField } as Instr, { op: "local.set", index: localIdx } as Instr],
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
    if (paramType.kind === "ref_null" && apdInstrs.length > 0) {
      fctx.body.push({ op: "local.get", index: paramIdx });
      fctx.body.push({ op: "ref.is_null" } as Instr);
      fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: [], else: apdInstrs });
    } else {
      fctx.body.push(...apdInstrs);
    }
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
          const isUndefIdx = ensureLateImportShared(
            ctx,
            "__extern_is_undefined",
            [{ kind: "externref" }],
            [{ kind: "i32" }],
          );
          flushLateImportShiftsShared(ctx, fctx);
          if (isUndefIdx !== undefined) {
            fctx.body.push({ op: "call", funcIdx: isUndefIdx });
          } else {
            fctx.body.push({ op: "ref.is_null" } as Instr);
          }
          const savedBody = pushBody(fctx);
          compileExpression(ctx, fctx, bindingElem.initializer, bindingWasmType);
          fctx.body.push({ op: "local.set", index: localIdx } as Instr);
          const thenInstrs = fctx.body;
          fctx.body = savedBody;
          fctx.body.push({
            op: "if",
            blockType: { kind: "empty" },
            then: thenInstrs,
            else: [{ op: "local.get", index: tmpElem } as Instr, { op: "local.set", index: localIdx } as Instr],
          });
        } else if (bindingWasmType.kind === "ref_null" || bindingWasmType.kind === "ref") {
          // Internal struct refs: use ref.is_null for missing values
          const tmpElem = allocLocal(fctx, `__ary_dflt_${fctx.locals.length}`, bindingWasmType);
          fctx.body.push({ op: "local.tee", index: tmpElem });
          fctx.body.push({ op: "ref.is_null" } as Instr);
          const savedBody = pushBody(fctx);
          compileExpression(ctx, fctx, bindingElem.initializer, bindingWasmType);
          fctx.body.push({ op: "local.set", index: localIdx } as Instr);
          const thenInstrs = fctx.body;
          fctx.body = savedBody;
          fctx.body.push({
            op: "if",
            blockType: { kind: "empty" },
            then: thenInstrs,
            else: [{ op: "local.get", index: tmpElem } as Instr, { op: "local.set", index: localIdx } as Instr],
          });
        } else if (bindingWasmType.kind === "f64") {
          // f64: undefined is NaN, check NaN self-test
          const tmpElem = allocLocal(fctx, `__ary_dflt_${fctx.locals.length}`, bindingWasmType);
          fctx.body.push({ op: "local.tee", index: tmpElem });
          fctx.body.push({ op: "local.get", index: tmpElem });
          fctx.body.push({ op: "f64.ne" });
          const savedBody = pushBody(fctx);
          compileExpression(ctx, fctx, bindingElem.initializer, bindingWasmType);
          fctx.body.push({ op: "local.set", index: localIdx } as Instr);
          const thenInstrs = fctx.body;
          fctx.body = savedBody;
          fctx.body.push({
            op: "if",
            blockType: { kind: "empty" },
            then: thenInstrs,
            else: [{ op: "local.get", index: tmpElem } as Instr, { op: "local.set", index: localIdx } as Instr],
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
    if (paramType.kind === "ref_null" && apdaInstrs.length > 0) {
      fctx.body.push({ op: "local.get", index: paramIdx });
      fctx.body.push({ op: "ref.is_null" } as Instr);
      fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: [], else: apdaInstrs });
    } else {
      fctx.body.push(...apdaInstrs);
    }
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
    const undefIdx = ensureLateImportShared(ctx, "__extern_is_undefined", [{ kind: "externref" }], [{ kind: "i32" }]);
    flushLateImportShiftsShared(ctx, fctx);
    fctx.body.push({ op: "local.get", index: paramIdx });
    if (undefIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx: undefIdx } as Instr);
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
  // TDZ enforcement (#413): set up TDZ flags for parameters with defaults
  const hasDefaults = arrow.parameters.some((p) => !!p.initializer);
  let tdzFlags: number[] | undefined;
  if (hasDefaults) {
    if (!fctx.tdzFlagLocals) fctx.tdzFlagLocals = new Map();
    tdzFlags = [];
    for (let i = 0; i < arrow.parameters.length; i++) {
      const param = arrow.parameters[i]!;
      const paramName = ts.isIdentifier(param.name) ? param.name.text : `__param${i}`;
      const flagIdx = allocLocal(fctx, `__tdz_param_${paramName}`, { kind: "i32" });
      tdzFlags.push(flagIdx);
      fctx.tdzFlagLocals.set(paramName, flagIdx);
    }
  }
  const defaultArgcLocal =
    hasDefaults &&
    arrow.parameters.some((param, i) => {
      if (!param.initializer) return false;
      return paramDefaultNeedsArgc(fctx.params[paramOffset + i]?.type);
    })
      ? cacheParamDefaultArgc(ctx, fctx)
      : undefined;

  for (let i = 0; i < arrow.parameters.length; i++) {
    const param = arrow.parameters[i]!;
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
      ensureLateImportShared(ctx, "__extern_is_undefined", [{ kind: "externref" }], [{ kind: "i32" }]);
      flushLateImportShiftsShared(ctx, fctx);
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
    for (let i = 0; i < arrow.parameters.length; i++) {
      const param = arrow.parameters[i]!;
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
      ensureLateImportShared(ctx, "__extern_is_undefined", [{ kind: "externref" }], [{ kind: "i32" }]);
      flushLateImportShiftsShared(ctx, fctx);
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
 * #1311 — Host method names whose callable arg ALWAYS needs a JS-callable
 * `__make_callback` externref. These methods invoke the callback during the
 * call itself (the JS-side host implementation calls back into the runtime),
 * so the GC-struct closure shape can't satisfy them.
 *
 * Methods NOT in this set get the closure-struct path when their param is
 * callable — the value is stored, not invoked, so the cast at the eventual
 * dispatch site works. Examples: `Map.set`, `WeakMap.set`, `Set.add`,
 * `Array.push`, `Array.unshift`, user-defined methods.
 *
 * Note: array HOFs (`forEach`, `map`, `filter`, `reduce`, etc.) have
 * dedicated inline compilation in `src/codegen/array-methods.ts` and never
 * reach `isHostCallbackArgument` for their callback arg. They're listed
 * here defensively so that if the inline path is bypassed (e.g. on an
 * untyped receiver), the host-callback path is still chosen.
 */
const HOST_CALLBACK_METHODS = new Set<string>([
  // Array HOFs (defensive fallback — usually inlined upstream)
  "forEach",
  "map",
  "filter",
  "reduce",
  "reduceRight",
  "every",
  "some",
  "find",
  "findIndex",
  "findLast",
  "findLastIndex",
  "flatMap",
  "sort",
  // Promise prototype methods — JS microtask scheduler invokes the callback
  "then",
  "catch",
  "finally",
  // Object/JSON callbacks
  "fromEntries",
  // String.replace(pattern, replacer) — replacer is a callback
  "replace",
  "replaceAll",
]);

/**
 * (#2070) True when `recvType` is a JS `Array` (`T[]` / `Array<T>`) — used to
 * give `push`/`unshift` callback args the closure-struct path. Recognises the
 * type via its symbol name and, defensively, via the apparent type so a
 * narrowed/aliased array still matches. Typed arrays (`Uint8Array`, …) are not
 * `Array` and correctly fall through to the host-callback default.
 */
function isArrayLikeReceiverType(recvType: ts.Type, ctx: CodegenContext): boolean {
  const named = (t: ts.Type | undefined): boolean => t?.getSymbol?.()?.getName?.() === "Array";
  if (named(recvType)) return true;
  try {
    const apparent = ctx.checker.getApparentType?.(recvType);
    if (named(apparent)) return true;
    // typeToString covers the structural `T[]` form whose symbol may be absent.
    const asStr = ctx.checker.typeToString(recvType);
    if (/(\[\]|^Array<|^ReadonlyArray<)/.test(asStr) || asStr.endsWith("[]")) return true;
  } catch {
    // ignore checker errors — default to the host-callback path
  }
  return false;
}

/**
 * (#2640) True when `wt` is a (nullable) ref to a typed WasmGC vec/array
 * struct (`__vec_*`/`__arr_*`/`$__vec_base`). Used to widen array-like
 * generic-method callback params to externref (see
 * `ctx.forceExternrefCallbackParams`). Mirrors the `__vec_`/`__arr_`
 * receiver-bail detection in `compileArrayLikePrototypeCall`.
 */
function isVecOrArrayRefType(ctx: CodegenContext, wt: ValType): boolean {
  if (wt.kind !== "ref" && wt.kind !== "ref_null") return false;
  const typeIdx = (wt as { typeIdx: number }).typeIdx;
  const typeDef = ctx.mod.types[typeIdx];
  const name = typeDef && "name" in typeDef ? (typeDef as { name?: string }).name : undefined;
  if (!name) return false;
  return name.startsWith("__vec_") || name.startsWith("__arr_") || name === "__vec_base";
}

/** Check if an arrow/function expression is used as a callback argument to a call
 *  that targets a HOST import (not a user-defined function). User-defined functions
 *  should receive closures via the GC struct path, not the __make_callback host path. */
export function isHostCallbackArgument(node: ts.Node, ctx: CodegenContext): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isCallExpression(parent)) {
    if (!parent.arguments.some((arg) => arg === node)) return false;
    // Check if the callee is a user-defined function — if so, NOT a host callback
    if (ts.isIdentifier(parent.expression)) {
      const calleeName = parent.expression.text;
      const funcIdx = ctx.funcMap.get(calleeName);
      if (funcIdx !== undefined && funcIdx >= ctx.numImportFuncs) {
        // User-defined function — use closure path, not host callback
        return false;
      }
      // (#1300) The callee is an identifier but not in funcMap — typically a
      // function-typed parameter or local. The receiving function expects
      // the GC-struct closure shape (`__fn_wrap_N_struct`) and will
      // `ref.cast` the externref it gets. Routing through the host
      // `__make_callback` path here produces a JS-wrapped externref that
      // fails the cast and null-derefs at the receiver's `struct.get`.
      // Detect via TypeScript's call-signature lookup on the identifier's
      // type and use the closure path if the callee is callable.
      try {
        const calleeType = ctx.checker.getTypeAtLocation(parent.expression);
        const callSigs = calleeType?.getCallSignatures?.();
        if (callSigs && callSigs.length > 0) {
          return false;
        }
      } catch {
        // Fall through to host-callback path on any checker error
      }
    }
    // For method calls (property access), check if the method is on a
    // user-defined class. User-defined methods receive the closure as the
    // GC-struct shape (`__fn_wrap_N_struct`) and may store it for later
    // dispatch (e.g. `app.routes.set(path, handler)`). Routing through
    // `__make_callback` here produces a JS-wrapped externref that fails the
    // dispatch-site `ref.cast` and null-derefs at `struct.get`. (#1311)
    if (ts.isPropertyAccessExpression(parent.expression)) {
      const propAccess = parent.expression;
      const methodName = propAccess.name.text;
      // (#3016) `Function.prototype.call`/`apply` NEVER invoke their arguments
      // as callbacks — they invoke the *receiver* with those args as `thisArg`
      // + forwarded params. So a function-expression/arrow passed to `.call`/
      // `.apply` (e.g. `get.call(() => {})` using a function object as an
      // invalid `this`, or `Array.prototype.find.call(undefined, fn)`) is a
      // plain function-object VALUE, not a synchronously-invoked host callback.
      // Routing it through `__make_callback` leaks an `env::` import in
      // standalone mode for no reason; the GC closure-struct path produces a
      // valid function-object value host-free (and any HOF that the *receiver*
      // then invokes — `Array.prototype.forEach.call(arr, cb)` — dispatches the
      // struct via `__call_fn_N`, verified host-free). Standalone-gated so the
      // js-host lane stays byte-identical.
      if (ctx.standalone && (methodName === "call" || methodName === "apply")) {
        return false;
      }
      try {
        const receiverType = ctx.checker.getTypeAtLocation(propAccess.expression);
        // Search the receiver type's symbol chain for a class name that
        // matches a user-defined method `${ClassName}_${methodName}`. We
        // check both the receiver's own symbol (instance methods) and the
        // type itself (handles `(typeof Foo).method` for statics).
        const candidates = new Set<string>();
        const recSym = receiverType.getSymbol?.();
        const recName = recSym?.getName?.();
        if (recName) candidates.add(recName);
        // Walk base types so inherited user-defined methods are detected
        const baseTypes = receiverType.getBaseTypes?.();
        if (baseTypes) {
          for (const bt of baseTypes) {
            const bs = bt.getSymbol?.()?.getName?.();
            if (bs) candidates.add(bs);
          }
        }
        for (const className of candidates) {
          const fullName = `${className}_${methodName}`;
          const funcIdx = ctx.funcMap.get(fullName);
          if (funcIdx !== undefined && funcIdx >= ctx.numImportFuncs) {
            // User-defined method on a user-defined class — closure path
            return false;
          }
        }
        // (#2070) Not a user-defined class method. A closure pushed onto an
        // array via `Array.prototype.push`/`unshift` is *stored*, not invoked,
        // and the eventual element-read call site (`fns[0]()`) dispatches it as
        // a WasmGC closure struct. Routing such a closure through the host
        // `__make_callback` path produces a JS-wrapped externref that fails the
        // read-site `ref.test`/`ref.cast` and null-derefs at `struct.get`. Give
        // array storage methods the closure-struct path instead.
        //
        // This is deliberately narrow: `Map.set`/`Set.add` and the deferred
        // DisposableStack methods keep the host-callback path because their
        // in-class dispatch wrappers (#1311) and writeback machinery (#1695)
        // depend on the JS-callable externref. The broader
        // HOST_CALLBACK_METHODS allowlist still governs the invoke-during-call
        // host methods (array HOFs, Promise.then, String.replace, …).
        if ((methodName === "push" || methodName === "unshift") && isArrayLikeReceiverType(receiverType, ctx)) {
          return false;
        }
      } catch {
        // Fall through to host-callback path on any checker error
      }
    }
    return true;
  }
  // NewExpression: `new Promise(executor)`, `new Map(comparator)`, etc.
  // Function args to constructors of extern classes need to be JS-callable.
  if (ts.isNewExpression(parent)) {
    if (!parent.arguments?.some((arg) => arg === node)) return false;
    // Check if the constructor is a user-defined class — if so, NOT a host callback
    if (ts.isIdentifier(parent.expression)) {
      const ctorName = parent.expression.text;
      const newFuncIdx = ctx.funcMap.get(classMemberFuncKey(ctx, `${ctorName}_new`)); // (#1983)
      if (newFuncIdx !== undefined && newFuncIdx >= ctx.numImportFuncs) {
        return false;
      }
      // (#28) `new Promise(executor)` — the executor must be invoked by the host
      // `Promise_new` import (which does `new Promise(_maybeWrapCallable(executor,
      // 2, …))`). The `__make_callback` host-callback path does NOT round-trip
      // here: an INLINE executor (`new Promise((res, rej) => …)`) routed through
      // it produced no callable wrapper, so the executor was silently never
      // invoked (resolve/reject `undefined`). Compiling the executor as a
      // first-class CLOSURE instead emits the `__call_fn_2` dispatcher that
      // `_maybeWrapCallable` uses to make the wasm closure JS-callable — the same
      // path the working `const exec = …; new Promise(exec)` form already takes.
      // So treat the Promise executor as a closure value, not a host callback.
      if (ctorName === "Promise") {
        return false;
      }
    }
    return true;
  }
  return false;
}

/**
 * Methods that STORE the callback for later invocation rather than calling it
 * synchronously during the call. Closures passed to these methods need
 * persistent ref-cell writebacks (re-emitted after every subsequent call) so
 * that mutations made when the callback eventually runs are reflected in the
 * outer scope. (#1695)
 *
 * Receiver-type-aware allowlist (className → method names): we only promote
 * to persistent writebacks when the receiver type matches — e.g. a user-defined
 * `class Foo { defer(cb) {} }` calling `foo.defer(...)` must NOT be promoted.
 */
const DEFERRED_CALLBACK_METHODS_BY_CLASS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["DisposableStack", new Set(["defer", "use", "adopt"])],
  ["AsyncDisposableStack", new Set(["defer", "use", "adopt"])],
]);

/**
 * Returns true if the arrow's parent CallExpression is a stored-callback host
 * method (DisposableStack.defer/use/adopt etc.). The callback is not invoked
 * synchronously by the call that registers it, so its captured-mutable
 * writebacks must be persistent. (#1695)
 */
export function isDeferredCallbackArgument(node: ts.Node, ctx: CodegenContext): boolean {
  const parent = node.parent;
  if (!parent || !ts.isCallExpression(parent)) return false;
  if (!parent.arguments.some((arg) => arg === node)) return false;
  if (!ts.isPropertyAccessExpression(parent.expression)) return false;
  const methodName = parent.expression.name.text;
  // (#3049) Invoke-through registrars: a function argument to `.call(…)` /
  // `.apply(…)` / `.bind(…)` reaches an UNKNOWN invoker that is typically
  // lazy — e.g. `Iterator.prototype.map.call(iter, fn)` invokes `fn` only
  // when the RESULT iterator is stepped, long after the registering call
  // returned. A one-shot writeback then snapshots the pre-invocation ref
  // cell, so captured-mutable counters (`++mapperCalls`) stay stale in the
  // outer function. Treat as deferred → persistent writebacks. (This only
  // triggers for HOST-boundary callbacks; `.call` on a compiled function
  // lowers its function args as closure structs, not host callbacks.)
  if (methodName === "call" || methodName === "apply" || methodName === "bind") return true;
  try {
    const recType = ctx.checker.getTypeAtLocation(parent.expression.expression);
    const symName = recType.getSymbol?.()?.getName?.();
    if (symName) {
      const methods = DEFERRED_CALLBACK_METHODS_BY_CLASS.get(symName);
      if (methods?.has(methodName)) return true;
    }
    const baseTypes = recType.getBaseTypes?.();
    if (baseTypes) {
      for (const bt of baseTypes) {
        const bn = bt.getSymbol?.()?.getName?.();
        if (!bn) continue;
        const m = DEFERRED_CALLBACK_METHODS_BY_CLASS.get(bn);
        if (m?.has(methodName)) return true;
      }
    }
  } catch {
    // checker failure → conservative false (no behavioural change)
  }
  return false;
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

function closureProvablyAfterLetDecl(
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

  // 1. Parameter types.
  const arrowParams: ValType[] = [];
  for (const p of arrow.parameters) {
    const paramType = ctx.checker.getTypeAtLocation(p);
    let wasmType = resolveWasmType(ctx, paramType);
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
      closureReturnType = resolveWasmType(ctx, retType);
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
    init: [{ op: "i32.const", value: 0 }] as Instr[],
  });
  ctx.genEagerFlagGlobalIdx = globalIdx;
  if (!ctx.funcMap.has("__gen_set_eager")) {
    const typeIdx = addFuncType(ctx, [{ kind: "i32" }], [], "__gen_set_eager");
    const funcIdx = mintDefinedFunc(ctx);
    pushDefinedFunc(ctx, funcIdx, {
      name: "__gen_set_eager",
      typeIdx,
      locals: [],
      body: [{ op: "local.get", index: 0 }, { op: "global.set", index: globalIdx } as Instr],
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
function genBodyReferencesThis(node: ts.Node): boolean {
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
 * (#3046) True when `node` is the **reviver** argument (2nd arg) of a
 * `JSON.parse(text, reviver)` call. Per ECMA-262 §25.5.1.1
 * `InternalizeJSONProperty`, the reviver is invoked as
 * `Call(reviver, holder, «name, val»)` — `this` MUST be the holder. The host
 * `JSON_parse` / `_invokeJsonCallable` bridge applies the holder as the JS
 * receiver, so the reviver callback must route through the `this`-forwarding
 * `__make_getter_callback` maker (needsThis) rather than the bare
 * `__make_callback`, which drops the receiver and leaves `this` non-object
 * (a `this.`-op such as `Object.defineProperty(this, …)` then throws
 * "called on non-object").
 */
function isJsonReviverArgument(node: ts.Node): boolean {
  const parent = node.parent;
  if (!parent || !ts.isCallExpression(parent)) return false;
  if (parent.arguments[1] !== node) return false; // must be the 2nd arg
  const callee = parent.expression;
  return (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === "JSON" &&
    callee.name.text === "parse"
  );
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

/** Compile an arrow function as a first-class closure value (Wasm GC struct + funcref) */
export function compileArrowAsClosure(
  ctx: CodegenContext,
  fctx: FunctionContext,
  arrow: ts.ArrowFunction | ts.FunctionExpression,
): ValType | null {
  const closureId = ctx.closureCounter++;
  const closureName = `__closure_${closureId}`;
  const body = arrow.body;

  // Check if this is a generator function expression (function*() { ... })
  const isGenerator = ts.isFunctionExpression(arrow) && arrow.asteriskToken !== undefined;
  if (isGenerator) {
    ctx.generatorFunctions.add(closureName);
  }
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
  }

  // 2. Analyze captured variables. Use scope-aware collection so that nested
  //    `var` declarations and parameter bindings inside the closure body shadow
  //    outer references — otherwise a closure with its own `var i;` would be
  //    treated as capturing the outer `i` (#995/#996).
  const ownLocals = new Set<string>();
  addFunctionOwnLocals(arrow, ownLocals); // (#2103) memoized own-locals
  if (ts.isFunctionExpression(arrow) && arrow.name) ownLocals.add(arrow.name.text);

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
  if (ts.isBlock(body)) {
    for (const stmt of body.statements) {
      collectReferencedIdentifiers(stmt, referencedNames, ownLocals);
    }
  } else {
    collectReferencedIdentifiers(body, referencedNames, ownLocals);
  }
  // (#3096) Free variables referenced ONLY in a parameter default initializer
  // — or in a binding-pattern element default / computed key — must be
  // captured too. The body scan above misses them, so a default like
  // `([x] = iter) => {}` (where `iter` is an outer var referenced nowhere in
  // the body) never captured `iter`; the default then compiled to `ref.null`,
  // and array destructuring threw "Cannot destructure null/undefined". Scan
  // `param.name` (catches binding-pattern element defaults + computed keys) and
  // `param.initializer` (top-level param default) with the same own-locals
  // shadow set, so the param's own binding names stay excluded.
  collectParamDefaultReferences(arrow.parameters, referencedNames, ownLocals);

  // Transitively add captures needed by called nested functions.
  // E.g. if this closure calls g() and g has nestedFuncCaptures {first, second},
  // this closure must also capture first and second so it can pass ref cells to g.
  for (const name of [...referencedNames]) {
    if (ownLocals.has(name)) continue;
    const transitiveCaptures = ctx.nestedFuncCaptures.get(name);
    if (transitiveCaptures) {
      for (const cap of transitiveCaptures) {
        if (!ownLocals.has(cap.name)) referencedNames.add(cap.name);
      }
    }
  }

  // Detect which captured variables are written inside the closure body
  const writtenInClosure = new Set<string>();
  if (ts.isBlock(body)) {
    for (const stmt of body.statements) {
      collectWrittenIdentifiers(stmt, writtenInClosure, ownLocals);
    }
  } else {
    collectWrittenIdentifiers(body, writtenInClosure, ownLocals);
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
      // Use the enclosing function body to find all writes to this name
      let enclosing: ts.Node | undefined = arrow.parent;
      while (
        enclosing &&
        !ts.isFunctionDeclaration(enclosing) &&
        !ts.isFunctionExpression(enclosing) &&
        !ts.isArrowFunction(enclosing) &&
        !ts.isMethodDeclaration(enclosing) &&
        !ts.isConstructorDeclaration(enclosing) &&
        !ts.isSourceFile(enclosing)
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
    // #2669: skip names bound to a *user* function (a function reference, not a
    // captured variable) — but NOT a wasm:js-string builtin import
    // (concat/length/equals/substring/charCodeAt), which lives in funcMap yet
    // must not block capture of a same-named outer local (e.g. the test262
    // `let length = "outer"` dstr template). Discriminate by index.
    if (ctx.funcMap.has(name) && ctx.funcMap.get(name) !== ctx.jsStringImports.get(name)) continue;
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
    // #1177: If we found the TDZ flag via fctx.locals scan (block-scope shadow
    // cleared tdzFlagLocals), seed fctx.tdzFlagLocals so downstream emit code
    // (including the construction-time emit below and the call-site TDZ check)
    // routes through the boxed flag mechanism.
    if (tdzFlagIdxFromScan !== undefined) {
      if (!fctx.tdzFlagLocals) fctx.tdzFlagLocals = new Map();
      if (!fctx.tdzFlagLocals.has(name)) fctx.tdzFlagLocals.set(name, tdzFlagIdxFromScan);
    }
    captures.push({ name, type, localIdx, mutable: isMutable, alreadyBoxed, hasTdzFlag });
  }

  // 3. Create struct type: field 0 = funcref, fields 1..N = captured vars
  //    For mutable captures, the field type is a ref cell (struct { value: T })
  const closureResults: ValType[] = closureReturnType ? [closureReturnType] : [];

  // For closures with no captures, reuse the shared wrapper struct type from
  // getOrCreateFuncRefWrapperTypes. This ensures all no-capture closures with
  // the same signature share the same struct type, enabling consistent call_ref
  // dispatch when closures are passed as callable parameters (externref).
  let structTypeIdx: number;
  let liftedFuncTypeIdx: number;
  let liftedParams: ValType[];
  const isNamedFuncExpr = ts.isFunctionExpression(arrow) && arrow.name;

  if (captures.length === 0 && !isNamedFuncExpr) {
    const wrapperTypes = getOrCreateFuncRefWrapperTypes(ctx, arrowParams, closureResults);
    if (wrapperTypes) {
      structTypeIdx = wrapperTypes.structTypeIdx;
      liftedFuncTypeIdx = wrapperTypes.liftedFuncTypeIdx;
      liftedParams = [{ kind: "ref", typeIdx: structTypeIdx }, ...arrowParams];
    } else {
      // Fallback: create a unique struct type
      const structFields = [{ name: "func", type: { kind: "funcref" as const }, mutable: false }];
      structTypeIdx = ctx.mod.types.length;
      ctx.mod.types.push({
        kind: "struct",
        name: `${closureName}_struct`,
        fields: structFields,
      });
      liftedParams = [{ kind: "ref", typeIdx: structTypeIdx }, ...arrowParams];
      liftedFuncTypeIdx = addFuncType(ctx, liftedParams, closureResults, `${closureName}_type`);
    }
  } else {
    const structFields = [
      { name: "func", type: { kind: "funcref" as const }, mutable: false },
      ...captures.map((c) => {
        if (c.mutable && !c.alreadyBoxed) {
          // First time boxing: create ref cell type for the capture value type
          const refCellTypeIdx = getOrRegisterRefCellType(ctx, c.type);
          return {
            name: c.name,
            type: { kind: "ref_null" as const, typeIdx: refCellTypeIdx },
            mutable: false,
          };
        }
        if (c.mutable && c.alreadyBoxed) {
          // Already boxed: the capture's type IS the ref cell type already
          return {
            name: c.name,
            type: c.type,
            mutable: false,
          };
        }
        return {
          name: c.name,
          type: c.type,
          mutable: false,
        };
      }),
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

    // For closures with captures (but not named func exprs), make the struct
    // a subtype of the shared wrapper struct so ref.cast at call sites succeeds.
    // Named func exprs need ref_null __self (for var hoisting), so they can't
    // share the wrapper's lifted func type which uses non-null ref.
    const wrapperTypes = !isNamedFuncExpr ? getOrCreateFuncRefWrapperTypes(ctx, arrowParams, closureResults) : null;

    structTypeIdx = ctx.mod.types.length;
    if (wrapperTypes) {
      // Subtype of the wrapper struct — inherits field 0 (funcref), adds captures
      ctx.mod.types.push({
        kind: "struct",
        name: `${closureName}_struct`,
        fields: structFields,
        superTypeIdx: wrapperTypes.structTypeIdx,
      });
      // Share the wrapper's lifted func type so call_ref dispatches correctly.
      // The __self param is (ref $wrapperStruct), and the lifted body will
      // ref.cast to the specific subtype to access captures.
      liftedFuncTypeIdx = wrapperTypes.liftedFuncTypeIdx;
      liftedParams = [{ kind: "ref_null", typeIdx: structTypeIdx }, ...arrowParams];
    } else {
      ctx.mod.types.push({
        kind: "struct",
        name: `${closureName}_struct`,
        fields: structFields,
      });
      // 4. Create the lifted function type: (ref_null $closure_struct, ...arrowParams) → results
      // Use ref_null for __self so that var-hoisted variables shadowing the function name
      // (e.g. `var g` inside `function g()`) can be default-initialized to null.
      liftedParams = [{ kind: "ref_null", typeIdx: structTypeIdx }, ...arrowParams];
      liftedFuncTypeIdx = addFuncType(ctx, liftedParams, closureResults, `${closureName}_type`);
    }
  }

  // 5. Build the lifted function body
  // For no-capture closures using wrapper types, self param is non-null ref.
  // For captured closures sharing wrapper types, self param uses the WRAPPER struct
  // type (non-null ref) — captures are accessed via ref.cast to the subtype.
  // For named func exprs, self param is ref_null (var hoisting support).
  const usesWrapperFuncType =
    captures.length > 0 && !isNamedFuncExpr && !!getOrCreateFuncRefWrapperTypes(ctx, arrowParams, closureResults);
  const selfParamKind = isNamedFuncExpr ? ("ref_null" as const) : ("ref" as const);
  const selfTypeIdx = usesWrapperFuncType
    ? getOrCreateFuncRefWrapperTypes(ctx, arrowParams, closureResults)!.structTypeIdx
    : structTypeIdx;
  const liftedFctx: FunctionContext = {
    name: closureName,
    params: [
      { name: "__self", type: { kind: selfParamKind, typeIdx: selfTypeIdx } },
      ...arrow.parameters.map((p, i) => ({
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

  // (#1384) Track liftedFctx.body in liveBodies BEFORE any emission so
  // addUnionImports / shiftLateImportIndices can shift any `call funcIdx`
  // instructions that get emitted during the captures-extraction prologue
  // (lines 1589-1635) and the TDZ-flag-extraction prologue (lines 1648-1660),
  // BOTH of which run BEFORE the savedFunc swap below that would otherwise
  // expose liftedFctx.body via ctx.currentFunc / funcStack to the shifter.
  ctx.liveBodies.add(liftedFctx.body);

  for (let i = 0; i < liftedFctx.params.length; i++) {
    liftedFctx.localMap.set(liftedFctx.params[i]!.name, i);
  }

  // Initialize locals for captured variables from struct fields.
  // When using wrapper func types, __self is typed as the wrapper base struct —
  // cast it to the specific subtype to access capture fields.
  let selfLocalForCaptures = 0; // default: param 0 (__self)
  if (usesWrapperFuncType && captures.length > 0) {
    const castLocal = allocLocal(liftedFctx, "__self_cast", { kind: "ref", typeIdx: structTypeIdx });
    liftedFctx.body.push({ op: "local.get", index: 0 }); // __self (wrapper base type)
    liftedFctx.body.push({ op: "ref.cast", typeIdx: structTypeIdx } as Instr);
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
        // Look up the original value type from the outer scope's boxed capture info
        const outerBoxed = fctx.boxedCaptures?.get(cap.name);
        valType = outerBoxed?.valType ?? { kind: "f64" };
      } else {
        refCellTypeIdx = getOrRegisterRefCellType(ctx, cap.type);
        valType = cap.type;
      }
      const refCellType: ValType = { kind: "ref_null", typeIdx: refCellTypeIdx };
      const localIdx = allocLocal(liftedFctx, cap.name, refCellType);
      selfCaptureLayoutEntries.push({ name: cap.name, fieldIdx: i + 1, localType: refCellType });
      liftedFctx.body.push({ op: "local.get", index: selfLocalForCaptures });
      liftedFctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx: i + 1 });
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
      const valType = outerBoxed?.valType ?? { kind: "f64" as const };
      const refCellType: ValType = { kind: "ref_null", typeIdx: refCellTypeIdx };
      const localIdx = allocLocal(liftedFctx, cap.name, refCellType);
      selfCaptureLayoutEntries.push({ name: cap.name, fieldIdx: i + 1, localType: refCellType });
      liftedFctx.body.push({ op: "local.get", index: selfLocalForCaptures });
      liftedFctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx: i + 1 });
      liftedFctx.body.push({ op: "local.set", index: localIdx });
      if (!liftedFctx.boxedCaptures) liftedFctx.boxedCaptures = new Map();
      liftedFctx.boxedCaptures.set(cap.name, { refCellTypeIdx, valType });
    } else {
      const localIdx = allocLocal(liftedFctx, cap.name, cap.type);
      selfCaptureLayoutEntries.push({ name: cap.name, fieldIdx: i + 1, localType: cap.type });
      liftedFctx.body.push({ op: "local.get", index: selfLocalForCaptures });
      liftedFctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx: i + 1 });
      liftedFctx.body.push({ op: "local.set", index: localIdx });
    }
  }

  // #1177: For TDZ-flagged captures, also extract the boxed flag ref into a
  // local in the lifted fctx and register it in `boxedTdzFlags` +
  // `tdzFlagLocals`. This makes existing TDZ-check call sites (calls.ts,
  // identifiers.ts) automatically route through `struct.get` on the ref cell.
  // Field-layout invariant: TDZ flag fields come AFTER all value fields,
  // i.e. fieldIdx = 1 + captures.length + tdzCaptureIndex.
  {
    const tdzFlaggedCapturesForPrologue = captures.filter((c) => c.hasTdzFlag);
    if (tdzFlaggedCapturesForPrologue.length > 0) {
      const i32RefCellTypeIdx = getOrRegisterRefCellType(ctx, { kind: "i32" });
      const flagRefType: ValType = { kind: "ref_null", typeIdx: i32RefCellTypeIdx };
      for (let ti = 0; ti < tdzFlaggedCapturesForPrologue.length; ti++) {
        const cap = tdzFlaggedCapturesForPrologue[ti]!;
        const tdzFieldIdx = 1 + captures.length + ti;
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
  const closureInfoForSelf: ClosureInfo = {
    structTypeIdx,
    funcTypeIdx: liftedFuncTypeIdx,
    returnType: closureReturnType,
    paramTypes: arrowParams,
  };
  if (funcExprName) {
    ctx.closureMap.set(funcExprName, closureInfoForSelf);
  }

  // (#2118) Register the self-recursive const/let arrow binding so recursive
  // calls compile as closure calls dispatched through __self. The struct.get
  // that fetches the funcref runs against __self's *actual* param type
  // (selfTypeIdx — the wrapper base struct when capture-subtyping is used, else
  // the specific struct), not necessarily the concrete subtype, so use
  // selfTypeIdx as the call-site struct type. Field 0 (funcref) is inherited
  // from the wrapper base, so the lifted func type still drives call_ref.
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
    });
  }

  // Emit default-value initialization for simple params with defaults
  emitArrowParamDefaults(ctx, liftedFctx, arrow, 1 /* skip __self */);

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
  for (let pi = 0; pi < arrow.parameters.length; pi++) {
    const param = arrow.parameters[pi]!;
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
                liftedFctx.body.push({ op: "i32.sub" } as Instr);
                liftedFctx.body.push({ op: "local.set", index: restLenLocal });
                // Clamp to 0 if negative
                liftedFctx.body.push({ op: "i32.const", value: 0 } as Instr);
                liftedFctx.body.push({ op: "local.get", index: restLenLocal });
                liftedFctx.body.push({ op: "local.get", index: restLenLocal });
                liftedFctx.body.push({ op: "i32.const", value: 0 } as Instr);
                liftedFctx.body.push({ op: "i32.lt_s" } as Instr);
                liftedFctx.body.push({ op: "select" } as Instr);
                liftedFctx.body.push({ op: "local.set", index: restLenLocal });

                // Create new data array
                const restArrLocal = allocLocal(liftedFctx, `__rest_arr_${liftedFctx.locals.length}`, {
                  kind: "ref",
                  typeIdx: arrTypeIdx,
                });
                liftedFctx.body.push({ op: "local.get", index: restLenLocal });
                liftedFctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx } as Instr);
                liftedFctx.body.push({ op: "local.set", index: restArrLocal });

                // array.copy(restArr, 0, srcData, ei, restLen)
                liftedFctx.body.push({ op: "local.get", index: restArrLocal });
                liftedFctx.body.push({ op: "i32.const", value: 0 });
                liftedFctx.body.push({ op: "local.get", index: srcParamIdx });
                liftedFctx.body.push({ op: "struct.get", typeIdx, fieldIdx: 1 }); // src data
                liftedFctx.body.push({ op: "i32.const", value: ei });
                liftedFctx.body.push({ op: "local.get", index: restLenLocal });
                liftedFctx.body.push({ op: "array.copy", dstTypeIdx: arrTypeIdx, srcTypeIdx: arrTypeIdx } as Instr);

                // Create new vec struct: struct.new(restLen, restArr)
                liftedFctx.body.push({ op: "local.get", index: restLenLocal });
                liftedFctx.body.push({ op: "local.get", index: restArrLocal });
                liftedFctx.body.push({ op: "struct.new", typeIdx } as Instr);

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
            if (resolvedParamType.kind === "ref_null" && fpadInstrs.length > 0) {
              liftedFctx.body.push({ op: "local.get", index: srcParamIdx });
              liftedFctx.body.push({ op: "ref.is_null" } as Instr);
              liftedFctx.body.push({ op: "if", blockType: { kind: "empty" }, then: [], else: fpadInstrs });
            } else {
              liftedFctx.body.push(...fpadInstrs);
            }
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
            if (resolvedParamType.kind === "ref_null" && fpadInstrs.length > 0) {
              liftedFctx.body.push({ op: "local.get", index: srcParamIdx });
              liftedFctx.body.push({ op: "ref.is_null" } as Instr);
              liftedFctx.body.push({ op: "if", blockType: { kind: "empty" }, then: [], else: fpadInstrs });
            } else {
              liftedFctx.body.push(...fpadInstrs);
            }
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
          if (paramType.kind === "ref_null" && fpodInstrs.length > 0) {
            liftedFctx.body.push({ op: "local.get", index: paramIdx });
            liftedFctx.body.push({ op: "ref.is_null" } as Instr);
            liftedFctx.body.push({ op: "if", blockType: { kind: "empty" }, then: [], else: fpodInstrs });
          } else {
            liftedFctx.body.push(...fpodInstrs);
          }
          handled = allFound;
        }
      }
      if (!handled) {
        allocBindingLocals(param.name);
      }
    }
  }

  // Set up `arguments` object for function expressions (not arrow functions).
  // Arrow functions don't have their own `arguments` binding in JS.
  if (ts.isFunctionExpression(arrow) && ts.isBlock(body) && closureBodyUsesArguments(body)) {
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
  if (ts.isBlock(body)) {
    hoistLetConstWithTdz(ctx, liftedFctx, body.statements);
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
      arrow.parameters.length === 0 &&
      !(ts.isBlock(body) && closureBodyUsesArguments(body)) &&
      !genBodyReferencesThis(body);
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
        ? [{ op: "call", funcIdx: getCaughtIdx } as Instr, { op: "local.set", index: pendingThrowLocal }]
        : [];
    liftedFctx.body.push({
      op: "try",
      blockType: { kind: "empty" },
      body: [{ op: "block", blockType: { kind: "empty" }, body: bodyInstrs }],
      catches: [{ tagIdx, body: catchBody }],
      catchAll: catchAllBody,
    });

    // Return __create_generator or __create_async_generator depending on async flag
    const createGenName = isAsync ? "__create_async_generator" : "__create_generator";
    // (#2865) Record legacy-buffer async gens so the .next() dispatch keeps a host miss arm.
    if (createGenName === "__create_async_generator") ctx.asyncGenLegacyBufferEmitted = true;
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
      liftedFctx.body.push({ op: "global.get", index: flagGlobalIdx } as Instr);
      liftedFctx.body.push({
        op: "if",
        blockType: { kind: "val", type: { kind: "externref" } },
        then: [
          { op: "i32.const", value: 0 } as Instr,
          { op: "global.set", index: flagGlobalIdx } as Instr,
          ...eagerSeq,
        ],
        else: [
          { op: "local.get", index: 0 } as Instr,
          { op: "extern.convert_any" } as Instr,
          { op: "ref.null.extern" } as Instr,
          { op: "call", funcIdx: createGenIdx } as Instr,
        ],
      } as Instr);
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
  if (closureReturnType && !conciseBodyHasValue) {
    const lastInstr = liftedFctx.body[liftedFctx.body.length - 1];
    if (!lastInstr || lastInstr.op !== "return") {
      if (closureReturnType.kind === "f64") {
        liftedFctx.body.push({ op: "f64.const", value: 0 });
      } else if (closureReturnType.kind === "i32") {
        liftedFctx.body.push({ op: "i32.const", value: 0 });
      } else if (closureReturnType.kind === "externref") {
        liftedFctx.body.push({ op: "ref.null.extern" });
      }
    }
  }

  if (savedFunc) ctx.funcStack.pop();
  if (savedFunc) ctx.parentBodiesStack.pop();
  ctx.currentFunc = savedFunc;

  // 6. Register the lifted function
  const liftedFuncIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, liftedFuncIdx, {
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

  // 7. At the creation site, emit struct.new with funcref + captured values
  fctx.body.push({ op: "ref.func", funcIdx: liftedFuncIdx });
  for (const cap of captures) {
    if (cap.mutable) {
      // Check if the outer scope already has this variable boxed (nested closure case)
      if (fctx.boxedCaptures?.has(cap.name)) {
        // Already a ref cell — pass the ref cell reference directly
        fctx.body.push({ op: "local.get", index: cap.localIdx });
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
      fctx.body.push({ op: "local.get", index: cap.localIdx });
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

  fctx.body.push({ op: "struct.new", typeIdx: structTypeIdx });

  // 8. Register closure info so call sites can emit call_ref
  const closureInfo: ClosureInfo = {
    structTypeIdx,
    funcTypeIdx: liftedFuncTypeIdx,
    returnType: closureReturnType,
    paramTypes: arrowParams,
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

  return { kind: "ref", typeIdx: structTypeIdx };
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
  const ownLocals = new Set<string>();
  addFunctionOwnLocals(arrow, ownLocals); // (#2103) memoized own-locals
  if (ts.isFunctionExpression(arrow) && arrow.name) ownLocals.add(arrow.name.text);
  const written = new Set<string>();
  const body = arrow.body;
  if (ts.isBlock(body)) {
    for (const stmt of body.statements) collectWrittenIdentifiers(stmt, written, ownLocals);
  } else {
    collectWrittenIdentifiers(body, written, ownLocals);
  }
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
  const ownLocals = new Set<string>();
  addFunctionOwnLocals(arrow, ownLocals); // (#2103) memoized own-locals
  if (ts.isFunctionExpression(arrow) && arrow.name) ownLocals.add(arrow.name.text);

  const referencedNames = new Set<string>();
  if (ts.isBlock(body)) {
    for (const stmt of body.statements) {
      collectReferencedIdentifiers(stmt, referencedNames, ownLocals);
    }
  } else {
    collectReferencedIdentifiers(body, referencedNames, ownLocals);
  }
  // (#3096) Also capture free variables referenced only in a parameter default
  // initializer / binding-pattern element default / computed key (see the
  // rationale on the identical scan in `compileArrowAsClosure`).
  collectParamDefaultReferences(arrow.parameters, referencedNames, ownLocals);

  // Detect which captured variables are written inside the callback body (#859)
  const writtenInCallback = new Set<string>();
  if (ts.isBlock(body)) {
    for (const stmt of body.statements) {
      collectWrittenIdentifiers(stmt, writtenInCallback, ownLocals);
    }
  } else {
    collectWrittenIdentifiers(body, writtenInCallback, ownLocals);
  }

  const captures: { name: string; type: ValType; localIdx: number; mutable: boolean; alreadyBoxed: boolean }[] = [];
  for (const name of referencedNames) {
    const localIdx = fctx.localMap.get(name);
    if (localIdx === undefined) continue;
    // #2669: skip names bound to a *user* function (a function reference, not a
    // captured variable) — but NOT a wasm:js-string builtin import
    // (concat/length/equals/substring/charCodeAt), which lives in funcMap yet
    // must not block capture of a same-named outer local (e.g. the test262
    // `let length = "outer"` dstr template). Discriminate by index.
    if (ctx.funcMap.has(name) && ctx.funcMap.get(name) !== ctx.jsStringImports.get(name)) continue;
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
    const fields: FieldDef[] = captures.map((cap) => {
      if (cap.mutable && !cap.alreadyBoxed) {
        const refCellTypeIdx = getOrRegisterRefCellType(ctx, cap.type);
        return {
          name: cap.name,
          type: { kind: "ref_null" as const, typeIdx: refCellTypeIdx },
          mutable: false,
        };
      }
      if (cap.mutable && cap.alreadyBoxed) {
        return {
          name: cap.name,
          type: cap.type,
          mutable: false,
        };
      }
      return {
        name: cap.name,
        type: cap.type,
        mutable: false,
      };
    });
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
  for (const p of arrow.parameters) {
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
        cbReturnType = resolveWasmType(ctx, retType);
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
  for (let i = 0; i < arrow.parameters.length; i++) {
    const p = arrow.parameters[i]!;
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
          valType = outerInfo?.valType ?? { kind: "f64" };
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

  // Emit destructuring code for binding pattern parameters
  for (let i = 0; i < arrow.parameters.length; i++) {
    const param = arrow.parameters[i]!;
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
  if (ts.isBlock(body)) {
    hoistLetConstWithTdz(ctx, cbFctx, body.statements);
  }

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

  if (cbReturnType && !exprBodyHasReturnValue) {
    const lastInstr = cbFctx.body[cbFctx.body.length - 1];
    if (!lastInstr || lastInstr.op !== "return") {
      if (cbReturnType.kind === "f64") {
        cbFctx.body.push({ op: "f64.const", value: 0 });
      } else if (cbReturnType.kind === "i32") {
        cbFctx.body.push({ op: "i32.const", value: 0 });
      } else if (cbReturnType.kind === "externref") {
        cbFctx.body.push({ op: "ref.null.extern" });
      }
    }
  }

  if (savedFunc) ctx.funcStack.pop();
  if (savedFunc) ctx.parentBodiesStack.pop();
  ctx.currentFunc = savedFunc;

  // 6. Register and export the callback function
  const cbFuncIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, cbFuncIdx, {
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
  const makeCallbackName = needsThis ? "__make_getter_callback" : "__make_callback";
  const makeCallbackIdx = ctx.funcMap.get(makeCallbackName);
  if (makeCallbackIdx === undefined) {
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
      } else {
        // Immutable capture or already-boxed: push directly
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
        writebacks.push({ op: "local.get", index: rc.refCellLocal } as Instr);
        writebacks.push({ op: "ref.is_null" } as Instr);
        writebacks.push({ op: "i32.eqz" } as Instr);
        writebacks.push({
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: rc.refCellLocal } as Instr,
            { op: "ref.as_non_null" } as Instr,
            { op: "struct.get", typeIdx: rc.refCellTypeIdx, fieldIdx: 0 } as Instr,
            { op: "local.set", index: rc.outerLocalIdx } as Instr,
          ],
          else: [],
        } as Instr);
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

/** A captured local that must flow into an async continuation. */
export interface AsyncCapture {
  readonly name: string;
  readonly type: ValType;
  readonly localIdx: number;
}

/** Result of synthesizing an async continuation `__cb_N` function. */
export interface SyntheticContinuation {
  /** Callback id — the host dispatches `__cb_${cbId}(captures, awaitValue)`. */
  readonly cbId: number;
  /** Capture struct type index (field i holds capture[i]), or -1 if no captures. */
  readonly capStructTypeIdx: number;
  /** The captures, in struct-field order. */
  readonly captures: readonly AsyncCapture[];
}

/**
 * (#1042) Synthesize an async-continuation function for the CPS state machine.
 *
 * Unlike {@link compileArrowAsCallback} this is driven by an explicit statement
 * list + capture set (not an arrow AST node). It emits an exported
 * `__cb_${cbId}(captures: externref, awaitValue: externref) -> externref`
 * function compatible with the `__make_callback` host bridge: the host invokes
 * it with the settled promise value as `awaitValue`. The function restores
 * captured locals from the capture struct, binds the awaited result to
 * `resumeBinding` (if any), runs `segmentStmts`, and returns `ref.null.extern`
 * (the host ignores a continuation's result).
 *
 * Returns the cbId + capture-struct info so the caller emits the creation site
 * (`i32.const cbId` + capture struct + `extern.convert_any` + `__make_callback`).
 *
 * Captures are immutable snapshots (value-copied into the struct) — async
 * continuations don't write back to the suspended frame, so no ref cells.
 */
export function compileSyntheticAsyncContinuation(
  ctx: CodegenContext,
  outerFctx: FunctionContext,
  segmentStmts: readonly ts.Statement[],
  captures: readonly AsyncCapture[],
  resumeBinding: { name: string; type: ValType } | null,
  options?: { returnAwaitValue?: boolean },
): SyntheticContinuation {
  const cbId = ctx.callbackCounter++;
  const cbName = `__cb_${cbId}`;

  // 1. Capture struct: field i = captures[i].type (immutable snapshot).
  let capStructTypeIdx = -1;
  if (captures.length > 0) {
    const fields: FieldDef[] = captures.map((c) => ({ name: c.name, type: c.type, mutable: false }));
    capStructTypeIdx = ctx.mod.types.length;
    ctx.mod.types.push({ kind: "struct", name: `__cb_cap_${cbId}`, fields } as StructTypeDef);
  }

  // 2. Function signature: (externref captures, externref awaitValue) -> externref.
  const cbParams: ValType[] = [{ kind: "externref" }, { kind: "externref" }];
  const cbResults: ValType[] = [{ kind: "externref" }];
  const cbTypeIdx = addFuncType(ctx, cbParams, cbResults, `${cbName}_type`);

  const cbFctx: FunctionContext = {
    name: cbName,
    params: [
      { name: "__captures", type: { kind: "externref" } },
      { name: "__awaitValue", type: { kind: "externref" } },
    ],
    locals: [],
    localMap: new Map(),
    returnType: { kind: "externref" },
    body: [],
    blockDepth: 0,
    breakStack: [],
    continueStack: [],
    labelMap: new Map(),
    savedBodies: [],
    enclosingClassName: outerFctx.enclosingClassName ?? resolveEnclosingClassName(outerFctx),
    isStaticContext: outerFctx.isStaticContext,
    readsCurrentThis: true,
  };
  for (let i = 0; i < cbFctx.params.length; i++) cbFctx.localMap.set(cbFctx.params[i]!.name, i);

  // (#1384) track body for late-import index shifting before any emission.
  ctx.liveBodies.add(cbFctx.body);

  // 3. Restore captured locals from the captures struct.
  //    __captures is externref; convert to anyref + cast to the cap struct.
  if (captures.length > 0) {
    const capLocal = allocLocal(cbFctx, "__cap_struct", { kind: "ref", typeIdx: capStructTypeIdx });
    cbFctx.body.push({ op: "local.get", index: 0 }); // __captures (externref)
    cbFctx.body.push({ op: "any.convert_extern" } as Instr);
    cbFctx.body.push({ op: "ref.cast", typeIdx: capStructTypeIdx } as Instr);
    cbFctx.body.push({ op: "local.set", index: capLocal });
    for (let i = 0; i < captures.length; i++) {
      const cap = captures[i]!;
      const localIdx = allocLocal(cbFctx, cap.name, cap.type);
      cbFctx.body.push({ op: "local.get", index: capLocal });
      cbFctx.body.push({ op: "struct.get", typeIdx: capStructTypeIdx, fieldIdx: i });
      cbFctx.body.push({ op: "local.set", index: localIdx });
    }
  }

  // 4. Bind the awaited result. `__awaitValue` arrives as externref; coerce to
  //    the binding's declared wasm type (e.g. f64 via __unbox_number).
  if (resumeBinding) {
    const bindIdx = allocLocal(cbFctx, resumeBinding.name, resumeBinding.type);
    cbFctx.body.push({ op: "local.get", index: 1 }); // __awaitValue
    if (resumeBinding.type.kind === "externref") {
      // already externref — store as-is
    } else {
      coerceType(ctx, cbFctx, { kind: "externref" }, resumeBinding.type);
    }
    cbFctx.body.push({ op: "local.set", index: bindIdx });
  }

  // 5. Compile the post-await segment statements.
  const savedFunc = ctx.currentFunc;
  if (savedFunc) ctx.parentBodiesStack.push(savedFunc.body);
  if (savedFunc) ctx.funcStack.push(savedFunc);
  ctx.currentFunc = cbFctx;
  for (const stmt of segmentStmts) compileStatement(ctx, cbFctx, stmt);
  if (savedFunc) ctx.funcStack.pop();
  if (savedFunc) ctx.parentBodiesStack.pop();
  ctx.currentFunc = savedFunc;

  // 6. Tail value. For `return await P` (returnAwaitValue) the continuation is
  //    the identity: the chained promise must resolve to the awaited value, so
  //    return `__awaitValue` (param index 1). Otherwise the continuation's own
  //    `return` settles the chained promise; a bare suffix falls through to
  //    `undefined` (ref.null.extern).
  const last = cbFctx.body[cbFctx.body.length - 1];
  if (!last || last.op !== "return") {
    if (options?.returnAwaitValue) {
      cbFctx.body.push({ op: "local.get", index: 1 });
    } else {
      cbFctx.body.push({ op: "ref.null.extern" });
    }
  }

  // 7. Register + export the continuation (the __make_callback host bridge
  //    dispatches by the exported `__cb_${cbId}` name).
  const cbFuncIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, cbFuncIdx, {
    name: cbName,
    typeIdx: cbTypeIdx,
    locals: cbFctx.locals,
    body: cbFctx.body,
    exported: true,
  });
  ctx.liveBodies.delete(cbFctx.body);
  ctx.funcMap.set(cbName, cbFuncIdx);
  ctx.mod.exports.push({ name: cbName, desc: { kind: "func", index: cbFuncIdx } });

  return { cbId, capStructTypeIdx, captures };
}

/**
 * Look up a function's parameter and result types from its index.
 */
export function getFuncSignature(
  ctx: CodegenContext,
  funcIdx: number,
): { params: ValType[]; results: ValType[] } | null {
  // #1916 S2 — funcSignatureOf is the positional-read chokepoint (func-space.ts).
  const sig = funcSignatureOf(ctx, funcIdx);
  return sig ? { params: sig.params, results: sig.results } : null;
}

/**
 * Get or create the closure struct type and lifted func type for wrapping
 * plain functions with a given signature. Struct type and func type are shared
 * across all functions with the same signature, but each function gets its own
 * trampoline.
 */
export function getOrCreateFuncRefWrapperTypes(
  ctx: CodegenContext,
  userParams: ValType[],
  resultTypes: ValType[],
): { structTypeIdx: number; liftedFuncTypeIdx: number; closureInfo: ClosureInfo } | null {
  // Build cache key from param types and result types
  const sigKey = `${userParams.map((p) => p.kind + ((p as any).typeIdx ?? "")).join(",")}->${resultTypes.map((r) => r.kind + ((r as any).typeIdx ?? "")).join(",")}`;

  const cached = ctx.funcRefWrapperCache.get(sigKey);
  if (cached) {
    return { structTypeIdx: cached.structTypeIdx, liftedFuncTypeIdx: cached.funcTypeIdx, closureInfo: cached };
  }

  // Create the closure struct type: just (field $func funcref), no captures.
  // Mark as non-final (superTypeIdx = -1) so closures with captures can be
  // subtypes of this wrapper struct, enabling ref.cast to succeed at call sites.
  const closureName = `__fn_wrap_${ctx.closureCounter++}`;
  const structFields = [{ name: "func", type: { kind: "funcref" as const }, mutable: false }];
  const structTypeIdx = ctx.mod.types.length;
  const rootWrapperTypeIdx = (ctx as unknown as { __funcRefWrapperRootTypeIdx?: number }).__funcRefWrapperRootTypeIdx;
  ctx.mod.types.push({
    kind: "struct",
    name: `${closureName}_struct`,
    fields: structFields,
    superTypeIdx: rootWrapperTypeIdx ?? -1, // first wrapper is the root; later signatures subtype it
  });
  if (rootWrapperTypeIdx === undefined) {
    (ctx as unknown as { __funcRefWrapperRootTypeIdx?: number }).__funcRefWrapperRootTypeIdx = structTypeIdx;
  }

  // Create the lifted function type: (ref $struct, ...userParams) -> results
  const liftedParams: ValType[] = [{ kind: "ref", typeIdx: structTypeIdx }, ...userParams];
  const liftedFuncTypeIdx = addFuncType(ctx, liftedParams, resultTypes, `${closureName}_type`);

  const closureInfo: ClosureInfo = {
    structTypeIdx,
    funcTypeIdx: liftedFuncTypeIdx,
    returnType: resultTypes.length > 0 ? resultTypes[0]! : null,
    paramTypes: userParams,
  };
  ctx.closureInfoByTypeIdx.set(structTypeIdx, closureInfo);
  ctx.funcRefWrapperCache.set(sigKey, closureInfo);

  return { structTypeIdx, liftedFuncTypeIdx, closureInfo };
}

/**
 * (#2976) Emit the memoized, `ref.is_null`-guarded VALUE instance of a
 * capture-carrying nested function declaration:
 *
 *   local.get $memo
 *   ref.is_null
 *   if (empty)                       ;; first DYNAMIC reference only
 *     ref.func $tramp
 *     <capture pushes>               ;; unchanged from the per-site build
 *     struct.new $__fn_cap_<name>
 *     local.set $memo
 *   end
 *   local.get $memo
 *   ref.as_non_null
 *
 * The memo local is allocated once per enclosing activation
 * (`fctx.nestedFnClosureMemos`), so every reference yields the SAME struct
 * instance — `f === f` holds and sidecar/static writes (`f.resolve = fn`)
 * are visible through later references. The runtime guard (not a prologue
 * hoist, not compile-order memoization) is load-bearing twice over:
 *   - it preserves value-capture semantics — immutable captures copy their
 *     value at the first DYNAMIC reference, exactly where the old per-site
 *     build copied them (a prologue hoist would run before hoisted-over
 *     initializers);
 *   - it is control-flow-safe — with compile-order memoization, a reference
 *     in a runtime-skipped branch would leave a later branch reading an
 *     uninitialized local.
 * The capture-push block keeps its compile-time side effects (mutable-capture
 * boxing + localMap rebind, TDZ flag boxing) — they now occur while compiling
 * the guard arm, same net effect as before.
 */
function emitMemoizedNestedFnClosure(
  ctx: CodegenContext,
  fctx: FunctionContext,
  funcName: string,
  structTypeIdx: number,
  trampolineFuncIdx: number,
  nestedCaptures: NonNullable<ReturnType<CodegenContext["nestedFuncCaptures"]["get"]>>,
  tdzFlaggedNested: NonNullable<ReturnType<CodegenContext["nestedFuncCaptures"]["get"]>>,
): void {
  const numCaptures = nestedCaptures.length;
  const numTdzFlags = tdzFlaggedNested.length;

  let memoLocal = fctx.nestedFnClosureMemos?.get(funcName);
  if (memoLocal === undefined) {
    memoLocal = allocLocal(fctx, `__fnmemo_${funcName}_${fctx.locals.length}`, {
      kind: "ref_null",
      typeIdx: structTypeIdx,
    });
    (fctx.nestedFnClosureMemos ??= new Map()).set(funcName, memoLocal);
  }

  fctx.body.push({ op: "local.get", index: memoLocal });
  fctx.body.push({ op: "ref.is_null" });

  // Build the construction sequence into the guard's then-arm.
  const savedBody = pushBody(fctx);

  // struct.new fields: func, cap0, cap1, ..., __tdz_*...
  fctx.body.push({ op: "ref.func", funcIdx: trampolineFuncIdx });
  // (#1312) Self-reference inside the lifted body of `funcName` itself —
  // e.g. `function next() { return call(next); }`. The captures are
  // already in scope as the leading params [0..numCaptures-1] of the
  // lifted fn (mutable captures arrive as boxed ref cells, immutable as
  // raw values). We re-push them by param index instead of trying to
  // dereference `cap.outerLocalIdx`, which points into a different
  // (outer) scope and yields garbage / null when reused inside the
  // current lifted body.
  const isSelfRef = fctx.name === funcName;
  for (let i = 0; i < nestedCaptures.length; i++) {
    const cap = nestedCaptures[i]!;
    if (isSelfRef) {
      // Captures arrive at param index `i` in the lifted fn (#1312).
      fctx.body.push({ op: "local.get", index: i });
      continue;
    }
    // (#2029 family A) Cross-fctx capture sourcing. `cap.outerLocalIdx` is a
    // slot in the function that DECLARED the nested fn; when this
    // materialization runs inside a DIFFERENT function (an object-literal
    // accessor body — the enclosing fn's locals are unreachable), baking it
    // emit-crashes ("local index out of range") or silently reads the wrong
    // local. `promoteAccessorCapturesToGlobals` promotes such captures to
    // module globals (shared ref-cell box for mutable, value global for
    // immutable); prefer those whenever the current fctx cannot resolve the
    // name itself. Guarded on localMap-absence so owner-fctx behavior is
    // unchanged (see the #1177 revert note in calls.ts for why a blanket
    // localMap-first lookup is NOT safe).
    const capUnresolvedHere = fctx.localMap.get(cap.name) === undefined;
    if (cap.mutable && cap.valType) {
      const refCellTypeIdx = getOrRegisterRefCellType(ctx, cap.valType);
      const boxGlobal = capUnresolvedHere ? ctx.capturedBoxGlobals?.get(cap.name) : undefined;
      if (fctx.boxedCaptures?.has(cap.name)) {
        const currentLocalIdx = fctx.localMap.get(cap.name)!;
        fctx.body.push({ op: "local.get", index: currentLocalIdx });
      } else if (boxGlobal !== undefined) {
        // Shared ref-cell box promoted to a module global — live
        // write-through semantics with the declaring function.
        fctx.body.push({ op: "global.get", index: boxGlobal.globalIdx });
        fctx.body.push({ op: "ref.as_non_null" });
      } else if (capUnresolvedHere && ctx.capturedGlobals.has(cap.name)) {
        // Value global (the capture is also directly referenced by the
        // accessor body) — box a copy. Best-effort: writes through the
        // closure do not propagate back, but the previous behavior was an
        // out-of-scope local read (emit crash / wrong local).
        fctx.body.push({ op: "global.get", index: ctx.capturedGlobals.get(cap.name)! });
        if (ctx.capturedGlobalsWidened.has(cap.name)) {
          fctx.body.push({ op: "ref.as_non_null" });
        }
        fctx.body.push({ op: "struct.new", typeIdx: refCellTypeIdx });
      } else {
        // Stage 1 localMap-first lookup reverted — see calls.ts comment.
        fctx.body.push({ op: "local.get", index: cap.outerLocalIdx });
        fctx.body.push({ op: "struct.new", typeIdx: refCellTypeIdx });
        const boxedLocalIdx = allocLocal(fctx, `__boxed_${cap.name}`, {
          kind: "ref",
          typeIdx: refCellTypeIdx,
        });
        fctx.body.push({ op: "local.tee", index: boxedLocalIdx });
        fctx.localMap.set(cap.name, boxedLocalIdx);
        if (!fctx.boxedCaptures) fctx.boxedCaptures = new Map();
        fctx.boxedCaptures.set(cap.name, { refCellTypeIdx, valType: cap.valType });
      }
    } else if (capUnresolvedHere && ctx.capturedGlobals.has(cap.name)) {
      // (#2029 family A) Immutable capture promoted to a value global by
      // the accessor-capture pass — read it instead of the out-of-scope
      // declaring-function local slot.
      fctx.body.push({ op: "global.get", index: ctx.capturedGlobals.get(cap.name)! });
      if (ctx.capturedGlobalsWidened.has(cap.name)) {
        fctx.body.push({ op: "ref.as_non_null" });
      }
    } else {
      fctx.body.push({ op: "local.get", index: cap.outerLocalIdx });
    }
  }
  // #1205 Stage 3: after all value captures, push the boxed TDZ flag refs
  // (one per TDZ-flagged capture). Sourcing rules mirror calls.ts — see
  // the FNDECL-A4 cap-prepend block there for the full rationale. The
  // short version: only trust the LIVE `fctx.tdzFlagLocals[name]` lookup
  // when it points to an i32 in the current fctx. Otherwise (block-shadow
  // or cross-fctx transitive) push `i32.const 1` (treat as initialized) —
  // matches pre-#1205 behavior where the lifted body had no flag check.
  if (numTdzFlags > 0) {
    const i32RefCellTypeIdxForFlags = getOrRegisterRefCellType(ctx, { kind: "i32" });
    for (let ti = 0; ti < tdzFlaggedNested.length; ti++) {
      const cap = tdzFlaggedNested[ti]!;
      if (isSelfRef) {
        // (#1312) Self-reference inside the lifted body — the TDZ-flag
        // boxed refs arrive as params at index `numCaptures + ti` (after
        // all value captures). Re-push from there.
        fctx.body.push({ op: "local.get", index: numCaptures + ti });
        continue;
      }
      const existingBox = fctx.boxedTdzFlags?.get(cap.name);
      if (existingBox) {
        fctx.body.push({ op: "local.get", index: existingBox.localIdx });
      } else {
        const liveFlagIdx = fctx.tdzFlagLocals?.get(cap.name);
        const liveType = liveFlagIdx !== undefined ? getLocalType(fctx, liveFlagIdx) : undefined;
        const liveOk = liveType?.kind === "i32";
        if (liveOk && liveFlagIdx !== undefined) {
          fctx.body.push({ op: "local.get", index: liveFlagIdx });
          fctx.body.push({ op: "struct.new", typeIdx: i32RefCellTypeIdxForFlags });
        } else {
          fctx.body.push({ op: "i32.const", value: 1 });
          fctx.body.push({ op: "struct.new", typeIdx: i32RefCellTypeIdxForFlags });
        }
        const flagBoxLocal = allocLocal(fctx, `__tdz_box_${cap.name}`, {
          kind: "ref",
          typeIdx: i32RefCellTypeIdxForFlags,
        });
        fctx.body.push({ op: "local.tee", index: flagBoxLocal });
        if (liveOk) {
          if (!fctx.boxedTdzFlags) fctx.boxedTdzFlags = new Map();
          fctx.boxedTdzFlags.set(cap.name, {
            refCellTypeIdx: i32RefCellTypeIdxForFlags,
            localIdx: flagBoxLocal,
          });
          if (!fctx.tdzFlagLocals) fctx.tdzFlagLocals = new Map();
          fctx.tdzFlagLocals.set(cap.name, flagBoxLocal);
        }
      }
    }
  }
  fctx.body.push({ op: "struct.new", typeIdx: structTypeIdx });
  fctx.body.push({ op: "local.set", index: memoLocal });

  const thenArm = fctx.body;
  popBody(fctx, savedBody);

  fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: thenArm, else: [] });
  fctx.body.push({ op: "local.get", index: memoLocal });
  fctx.body.push({ op: "ref.as_non_null" });
}

/**
 * Emit a closure struct wrapping a plain function. Creates a per-function
 * trampoline that delegates to the original function.  Struct types are shared
 * across functions with the same signature so they can be reassigned.
 * Pushes the closure struct ref onto the stack and returns its type.
 */
export function emitFuncRefAsClosure(
  ctx: CodegenContext,
  fctx: FunctionContext,
  funcName: string,
  funcIdx: number,
): ValType | null {
  const sig = getFuncSignature(ctx, funcIdx);
  if (!sig) return null;

  const nestedCaptures = ctx.nestedFuncCaptures.get(funcName);
  if (nestedCaptures && nestedCaptures.length > 0) {
    // Functions with captures: create a closure struct that stores the capture values.
    // The trampoline extracts captures from the struct and passes them to the original function. (#857)
    //
    // (#2976) IDENTITY: the struct type + trampoline are minted ONCE per
    // funcName (module-level `nestedFnClosureArtifacts` dedupe below), and the
    // INSTANCE is memoized per enclosing activation in a `ref.is_null`-guarded
    // local (`fctx.nestedFnClosureMemos`). Previously every reference site
    // built a fresh struct type + trampoline + instance, so
    // `Constructor === Constructor` was false and a static/sidecar write
    // (`Constructor.resolve = fn`) landed on a dead instance the next
    // reference never saw (the #2671 Promise capability sub-bucket). The
    // lazy guard — rather than a prologue hoist — preserves the existing
    // value-capture semantics exactly: immutable captures copy their value at
    // the FIRST DYNAMIC reference, the same point the old per-site build
    // copied them; mutable captures were already live through ref cells.
    const numCaptures = nestedCaptures.length;
    // #1205 Stage 3: TDZ-flag captures get extra ref-cell fields after the
    // value captures, mirroring the leading-param layout of the lifted fn.
    const tdzFlaggedNested = nestedCaptures.filter((c) => c.hasTdzFlag);
    const numTdzFlags = tdzFlaggedNested.length;
    // The lifted fn's signature is [valueCaps..., tdzFlagBoxes..., userParams...].
    const userParams = sig.params.slice(numCaptures + numTdzFlags);
    const results = sig.results;

    const wrapperTypes = getOrCreateFuncRefWrapperTypes(ctx, userParams, results);
    if (!wrapperTypes) return null;

    const cachedArtifacts = ctx.nestedFnClosureArtifacts?.get(funcName);
    if (cachedArtifacts) {
      const trampIdx = ctx.funcMap.get(cachedArtifacts.trampolineName);
      if (trampIdx !== undefined) {
        emitMemoizedNestedFnClosure(
          ctx,
          fctx,
          funcName,
          cachedArtifacts.structTypeIdx,
          trampIdx,
          nestedCaptures,
          tdzFlaggedNested,
        );
        return { kind: "ref", typeIdx: cachedArtifacts.structTypeIdx };
      }
    }

    // Create a custom struct with func + capture fields + TDZ-flag fields
    // (subtype of the base wrapper).
    const captureFields: FieldDef[] = nestedCaptures.map((_cap, i) => {
      const capParamType = sig.params[i]!;
      return { name: `cap${i}`, type: capParamType, mutable: false };
    });
    // #1205 Stage 3: append TDZ-flag ref-cell fields after the value captures
    // so the trampoline's struct.get of the flag uses the correct field index.
    let i32RefCellTypeIdxForFlags = -1;
    if (numTdzFlags > 0) {
      i32RefCellTypeIdxForFlags = getOrRegisterRefCellType(ctx, { kind: "i32" });
      for (const cap of tdzFlaggedNested) {
        captureFields.push({
          name: `__tdz_${cap.name}`,
          type: { kind: "ref" as const, typeIdx: i32RefCellTypeIdxForFlags },
          mutable: false,
        });
      }
    }
    const closureName = `__fn_cap_${funcName}_${ctx.closureCounter++}`;
    const structTypeIdx = ctx.mod.types.length;
    ctx.mod.types.push({
      kind: "struct",
      name: `${closureName}_struct`,
      fields: [{ name: "func", type: { kind: "funcref" as const }, mutable: false }, ...captureFields],
      superTypeIdx: wrapperTypes.structTypeIdx,
    });

    // Use the base wrapper's func type so call_ref works via subtype cast
    const liftedFuncTypeIdx = wrapperTypes.liftedFuncTypeIdx;

    const trampolineName = `__fn_tramp_${funcName}_${ctx.closureCounter++}`;
    const trampolineBody: Instr[] = [];
    const trampolineLocals: { name: string; type: ValType }[] = [];

    // We always need the casted-self local when we have either >1 value captures
    // OR any TDZ-flag fields, because each requires a separate `struct.get`.
    const totalCapFields = numCaptures + numTdzFlags;
    if (totalCapFields > 1) {
      trampolineLocals.push({ name: "__casted_self", type: { kind: "ref", typeIdx: structTypeIdx } });
    }
    const castedSelfLocal = 1 + userParams.length;

    // Cast self from base struct to custom struct to access capture fields
    trampolineBody.push({ op: "local.get", index: 0 } as Instr);
    trampolineBody.push({ op: "ref.cast", typeIdx: structTypeIdx });

    if (totalCapFields === 1) {
      // Exactly one capture field (a value capture; TDZ-flag-only with zero
      // value captures is impossible because each flag is paired with a value).
      trampolineBody.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx: 1 } as Instr);
    } else {
      trampolineBody.push({ op: "local.set", index: castedSelfLocal } as Instr);
      // Push value captures first, then TDZ-flag captures, mirroring the
      // lifted fn's leading-param order.
      for (let i = 0; i < totalCapFields; i++) {
        trampolineBody.push({ op: "local.get", index: castedSelfLocal } as Instr);
        trampolineBody.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx: i + 1 } as Instr);
      }
    }
    for (let i = 0; i < userParams.length; i++) {
      trampolineBody.push({ op: "local.get", index: i + 1 } as Instr);
    }
    trampolineBody.push({ op: "call", funcIdx } as Instr);

    const trampolineFuncIdx = mintDefinedFunc(ctx);
    pushDefinedFunc(ctx, trampolineFuncIdx, {
      name: trampolineName,
      typeIdx: liftedFuncTypeIdx,
      locals: trampolineLocals,
      body: trampolineBody,
      exported: false,
    });
    ctx.funcMap.set(trampolineName, trampolineFuncIdx);

    // Register closureInfo so array method callbacks can use call_ref
    const closureInfo: ClosureInfo = {
      structTypeIdx,
      funcTypeIdx: wrapperTypes.closureInfo.funcTypeIdx,
      returnType: results.length > 0 ? results[0]! : null,
      paramTypes: userParams,
    };
    ctx.closureInfoByTypeIdx.set(structTypeIdx, closureInfo);

    // (#2976) Register the module-level artifacts so every later reference —
    // in this or any other fctx — reuses this ONE struct type + trampoline
    // instead of minting fresh ones per site. Stored by trampoline NAME
    // (re-resolved via funcMap at emission) so late-import shifts can't
    // desync a cached raw index.
    (ctx.nestedFnClosureArtifacts ??= new Map()).set(funcName, { structTypeIdx, trampolineName });

    emitMemoizedNestedFnClosure(
      ctx,
      fctx,
      funcName,
      structTypeIdx,
      trampolineFuncIdx,
      nestedCaptures,
      tdzFlaggedNested,
    );
    return { kind: "ref", typeIdx: structTypeIdx };
  }

  const userParams = sig.params;

  const wrapperTypes = getOrCreateFuncRefWrapperTypes(ctx, userParams, sig.results);
  if (!wrapperTypes) return null;

  const { structTypeIdx, liftedFuncTypeIdx, closureInfo } = wrapperTypes;

  // Create a trampoline function for THIS specific function.
  // The trampoline takes (self, ...userParams) and calls the original function.
  const trampolineName = `__fn_tramp_${funcName}_${ctx.closureCounter++}`;
  const trampolineBody: Instr[] = [];

  // Push the user-visible params (skip self at param 0)
  for (let i = 0; i < userParams.length; i++) {
    trampolineBody.push({ op: "local.get", index: i + 1 } as Instr);
  }
  trampolineBody.push({ op: "call", funcIdx } as Instr);

  const trampolineFuncIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, trampolineFuncIdx, {
    name: trampolineName,
    typeIdx: liftedFuncTypeIdx,
    locals: [],
    body: trampolineBody,
    exported: false,
  });
  ctx.funcMap.set(trampolineName, trampolineFuncIdx);

  // Emit: ref.func $trampoline, struct.new $closure_struct
  fctx.body.push({ op: "ref.func", funcIdx: trampolineFuncIdx });
  fctx.body.push({ op: "struct.new", typeIdx: structTypeIdx });

  return { kind: "ref", typeIdx: structTypeIdx };
}

/**
 * (#2015) Build the `this`-slot prologue for an object-method trampoline.
 *
 * Object-literal / cached method trampolines bridge the closure-value ABI
 * `(closure_self, …userParams)` to the method ABI `(this_struct, …userParams)`.
 * Historically they hardcoded `ref.null <objStruct>` for the method's `this`
 * slot, implementing the unbound-`this` method-extraction case (`var f = o.m;
 * f()` → `this === undefined`). But the SAME trampoline is reached when the
 * closure is dispatched as a METHOD via `__call_fn_method_N`, which installs
 * the receiver into the `__current_this` module global before the inner
 * `call_ref` (#1636-S1). In that case the hardcoded null made `this.<field>`
 * trap (the issue's bare `WebAssembly.Exception`).
 *
 * Read `__current_this` instead and use it as `this` when it `ref.test`s as the
 * method's object struct; otherwise fall back to `ref.null` (preserving the
 * unbound-extraction semantics, since plain `__call_fn_N` dispatch leaves the
 * global null). This mirrors the null-guarded `__current_this` read that lifted
 * closure bodies already use for `ThisKeyword` (`expressions.ts`, #1702).
 *
 * `anyTempLocalIdx` must reference a spare `anyref` local appended to the
 * trampoline. Emits a sequence leaving exactly one `(ref null objStructTypeIdx)`
 * on the stack.
 */
/**
 * (#2025) Message thrown when an extracted method (`const f = a.m; f()`) is
 * called with no receiver — `this` is `undefined`. Matches the spirit of
 * Node's "Cannot read properties of undefined".
 */
const NULL_THIS_TYPEERROR_MSG = "Cannot read properties of undefined (reading a class field)";

/**
 * (#2025) Eagerly register the `__new_TypeError` import + the message string
 * the first time an extractable method-as-closure trampoline is built, so the
 * trampoline's null-`this` arm can emit a CATCHABLE TypeError throw with
 * stable, shift-tracked indices (no late-import registration during the
 * fragile finalize rebuild). Idempotent. Requires a live `fctx` so the flush
 * lands the deferred index shift onto the surrounding function being compiled.
 */
export function ensureNullThisTypeError(ctx: CodegenContext, fctx: FunctionContext | null): void {
  if (ctx.nullThisTypeErrorReady) return;
  // In no-JS-host mode, define `__new_TypeError` in-module (no env import).
  if (noJsHost(ctx)) {
    emitWasiErrorConstructor(ctx, "TypeError", 1);
  }
  addStringConstantGlobal(ctx, NULL_THIS_TYPEERROR_MSG);
  ensureLateImportShared(ctx, "__new_TypeError", [{ kind: "externref" }], [{ kind: "externref" }]);
  flushLateImportShiftsShared(ctx, fctx);
  ensureExnTag(ctx);
  ctx.nullThisTypeErrorReady = true;
}

/**
 * (#2025) The catchable-TypeError throw sequence for a genuinely-absent
 * receiver, or `null` when the helpers were not eagerly registered (in which
 * case the trampoline falls back to the legacy `ref.null` passthrough rather
 * than risk an unregistered call). Pure lookups — no registration, so it is
 * safe to call from the finalize rebuild (post-body, pre-freeze).
 */
function buildNullThisTypeErrorThrow(ctx: CodegenContext): Instr[] | null {
  if (!ctx.nullThisTypeErrorReady) return null;
  const newTypeErrorIdx = ctx.funcMap.get("__new_TypeError");
  if (newTypeErrorIdx === undefined || ctx.exnTagIdx < 0) return null;
  return [
    ...stringConstantExternrefInstrs(ctx, NULL_THIS_TYPEERROR_MSG),
    { op: "call", funcIdx: newTypeErrorIdx } as Instr,
    { op: "throw", tagIdx: ctx.exnTagIdx } as Instr,
  ];
}

/**
 * (#2025) Does the method's compiled body read its receiver (`this` = param 0)?
 * A method that never touches `this` is safely callable with a null receiver
 * (no struct.get on null), so the trampoline must NOT throw for it. We detect a
 * `local.get 0` anywhere in the body (including nested blocks). Conservative:
 * if the body isn't available yet (idx out of range), assume it does use `this`
 * so we don't silently regress the trap→TypeError fix.
 */
function methodBodyReadsThis(ctx: CodegenContext, methodFuncIdx: number): boolean {
  const fn = definedFuncAt(ctx, methodFuncIdx);
  if (!fn || !Array.isArray(fn.body)) return true;
  const walk = (instrs: Instr[]): boolean => {
    for (const instr of instrs) {
      if (instr.op === "local.get" && (instr as { index?: number }).index === 0) return true;
      for (const key of ["body", "then", "else", "catchAll"] as const) {
        const nested = (instr as Record<string, unknown>)[key];
        if (Array.isArray(nested) && walk(nested as Instr[])) return true;
      }
      const catches = (instr as { catches?: { body?: Instr[] }[] }).catches;
      if (Array.isArray(catches)) {
        for (const c of catches) if (Array.isArray(c.body) && walk(c.body)) return true;
      }
    }
    return false;
  };
  return walk(fn.body);
}

function buildTrampolineThisSlot(
  ctx: CodegenContext,
  objStructTypeIdx: number,
  anyTempLocalIdx: number,
  methodUsesThis: boolean,
): Instr[] {
  const currentThisGlobalIdx = ensureCurrentThisGlobal(ctx);
  const nullThis: Instr[] = [{ op: "ref.null", typeIdx: objStructTypeIdx } as Instr];
  if (currentThisGlobalIdx < 0) return nullThis;
  // (#2025) When the resolved `this` isn't the method's struct, distinguish a
  // GENUINELY-ABSENT receiver (`__current_this` null — the unbound extraction
  // `const f = a.m; f()`) from a merely structurally-different receiver (e.g. a
  // subclass/boxed instance, where `__current_this` is non-null but doesn't
  // `ref.test` as THIS exact struct). The first case is a spec TypeError; throw
  // a CATCHABLE one instead of passing `ref.null` (which traps inside the
  // method body on the first `this`-deref). The second case is left UNCHANGED
  // (`ref.null` passthrough) — throwing there is what regressed PR #1571 (it
  // fired for legitimate non-exact-struct receivers). Also only when the method
  // actually READS `this` — a method that ignores its receiver (`m(){return 7}`)
  // is callable with a null `this` (no deref, no trap), matching JS. Finally,
  // only when the throw helpers were eagerly registered; else legacy passthrough.
  const throwInstrs = methodUsesThis ? buildNullThisTypeErrorThrow(ctx) : null;
  const elseArm: Instr[] = throwInstrs
    ? [
        { op: "local.get", index: anyTempLocalIdx } as Instr,
        { op: "ref.is_null" } as Instr,
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "ref_null", typeIdx: objStructTypeIdx } },
          then: throwInstrs, // genuinely no receiver → catchable TypeError
          else: nullThis, // different struct → unchanged passthrough
        },
      ]
    : nullThis;
  return [
    { op: "global.get", index: currentThisGlobalIdx } as Instr,
    { op: "any.convert_extern" } as Instr,
    { op: "local.tee", index: anyTempLocalIdx } as Instr,
    { op: "ref.test", typeIdx: objStructTypeIdx } as Instr,
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "ref_null", typeIdx: objStructTypeIdx } },
      then: [
        { op: "local.get", index: anyTempLocalIdx } as Instr,
        { op: "ref.cast", typeIdx: objStructTypeIdx } as Instr,
      ],
      else: elseArm,
    },
  ];
}

/**
 * #1118: Emit an object-literal method as a first-class closure value.
 *
 * Object-literal methods are compiled as Wasm functions with signature
 * `(self_obj, ...userParams) → ret`. When the method is read as a value
 * (e.g. `var f = obj.m;` or stored in the obj's own struct field), we
 * need a closure-struct ref whose funcref takes `(closure_self, …userParams)`.
 *
 * The two signatures differ in their first param: the method expects the
 * object's struct ref, the closure value passes its own closure struct.
 * We bridge them with a trampoline that drops `closure_self` and pushes
 * `ref.null <objStruct>` for the method's `self_obj` slot, then forwards
 * the user params and tail-calls the method.
 *
 * The trampoline implements method extraction with unbound `this` — JS
 * spec says `var f = obj.m; f();` invokes `m` with `this = undefined`
 * (strict mode) or `this = globalThis` (sloppy). For methods that don't
 * reference `this` (the common test262 yield-star pattern), the null
 * `self_obj` is fine; methods that DO use `this` will trap inside the
 * body, mirroring spec semantics.
 *
 * Returns the closure-struct ref ValType (which the caller can convert
 * to externref via `extern.convert_any` if the field type expects it).
 */
export function emitObjectMethodAsClosure(
  ctx: CodegenContext,
  fctx: FunctionContext,
  methodName: string,
  methodFuncIdx: number,
  objStructTypeIdx: number,
): ValType | null {
  const sig = getFuncSignature(ctx, methodFuncIdx);
  if (!sig) return null;
  // Method signature: [(ref null objStruct), ...userParams] → results.
  // Strip the leading self_obj to derive the closure value's user-visible
  // signature.
  if (sig.params.length === 0) return null;
  const userParams = sig.params.slice(1);
  const results = sig.results;

  const wrapperTypes = getOrCreateFuncRefWrapperTypes(ctx, userParams, results);
  if (!wrapperTypes) return null;
  const { structTypeIdx, liftedFuncTypeIdx } = wrapperTypes;

  // Create the trampoline. Signature matches the wrapper's lifted func
  // type: (closure_self, ...userParams) → ret. We ignore closure_self,
  // resolve the method's self_obj from `__current_this` (#2015 — falls back
  // to `ref.null` for the unbound method-extraction case), then forward the
  // user params.
  const trampolineName = `__obj_meth_tramp_${methodName}_${ctx.closureCounter++}`;
  // anyref temp at the first slot past the params (closure_self + userParams).
  const anyTempLocalIdx = 1 + userParams.length;
  // (#2025) Decide whether the method reads `this` BEFORE registering the
  // TypeError helpers — `ensureNullThisTypeError` adds a late import that shifts
  // defined-function indices, which would make `methodFuncIdx` stale for the
  // body lookup. Then register the helpers (with a live fctx so the import-index
  // flush lands here) so the null-`this` arm throws instead of trapping and
  // finalize never registers an import mid-rebuild.
  // (#2025) Capture this-usage, then register the TypeError throw helpers. The
  // registration may add a late import that shifts every DEFINED function index
  // up by `ntShift`; the forwarding `call methodFuncIdx` we emit just below is in
  // a body not yet attached to `ctx.mod.functions`, so the import-shift walker
  // can't reach it — bump the captured index by the delta ourselves (import
  // targets, < the pre-shift import count, are never shifted).
  const methodUsesThis = methodBodyReadsThis(ctx, methodFuncIdx);
  const importsBeforeNT = ctx.numImportFuncs;
  ensureNullThisTypeError(ctx, fctx);
  const ntShift = ctx.numImportFuncs - importsBeforeNT;
  if (ntShift > 0 && inLiveShiftRange(methodFuncIdx, importsBeforeNT)) methodFuncIdx += ntShift;
  const trampolineBody: Instr[] = buildTrampolineThisSlot(ctx, objStructTypeIdx, anyTempLocalIdx, methodUsesThis);
  for (let i = 0; i < userParams.length; i++) {
    // Skip closure_self at param 0; user params start at index 1
    trampolineBody.push({ op: "local.get", index: i + 1 } as Instr);
  }
  trampolineBody.push({ op: "call", funcIdx: methodFuncIdx } as Instr);

  const trampolineFuncIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, trampolineFuncIdx, {
    name: trampolineName,
    typeIdx: liftedFuncTypeIdx,
    locals: [{ name: "__this_any", type: { kind: "anyref" } }],
    body: trampolineBody,
    exported: false,
  });
  ctx.funcMap.set(trampolineName, trampolineFuncIdx);

  // (#1602) The method's `func.typeIdx` may be re-resolved after this point
  // (generator/default-param methods finalize their param types/order during
  // body compilation). The forwarding body built above snapshots the CURRENT
  // signature; record it so a post-pass can rebuild it against the method's
  // final signature once all function bodies are compiled.
  ctx.pendingMethodTrampolines.push({
    trampolineBody,
    trampolineFuncIdx,
    methodFuncIdx,
    objStructTypeIdx,
    userParamCount: userParams.length,
    wrapperUserParams: userParams,
    wrapperResult: results[0],
    methodUsesThis, // (#2025) captured pre-shift; finalize reuses it
    // (#1809) Record whether the target is already an import at registration.
    // Import indices stay stable across late-import batches (new imports append
    // at the end, so indices < importsBefore are never shifted), so an import
    // target at finalize is EXPECTED, not a missed shift.
    methodTargetsImport: methodFuncIdx < ctx.numImportFuncs,
  });

  // Emit: ref.func $trampoline, struct.new $closure_struct
  fctx.body.push({ op: "ref.func", funcIdx: trampolineFuncIdx });
  fctx.body.push({ op: "struct.new", typeIdx: structTypeIdx });

  return { kind: "ref", typeIdx: structTypeIdx };
}

/**
 * (#1602) Rebuild every object-method-as-closure trampoline body against the
 * method's FINAL signature. Must run after all function bodies are compiled
 * (so `func.typeIdx` re-resolution has settled) and BEFORE late-import index
 * shifting, since the rebuilt body re-emits `call methodFuncIdx` at the current
 * (pre-shift) index — the shift machinery then walks it like any other body.
 *
 * The trampoline's own signature (its wrapper func type) is left untouched; we
 * only fix the forwarding body so its `local.get` count and the `call`'s
 * operand types match the method's resolved params. The wrapper's user-param
 * count is invariant (derived from the same method), so the trampoline param
 * indices stay valid; only the per-arg coercion is what could drift, and any
 * coercion the call needs is applied by mirroring the method's param types.
 */
export function finalizeMethodTrampolines(ctx: CodegenContext): void {
  for (const t of ctx.pendingMethodTrampolines) {
    // (#1525b / #1809) If the captured methodFuncIdx resolves to an IMPORT at
    // finalize (< ctx.numImportFuncs), there are two distinct cases:
    //
    //   1. The target was ALREADY an import at registration (`methodTargetsImport`)
    //      — e.g. a host/DOM global (`resizeTo`, `scrollBy`) or a `declare`d
    //      function used as a first-class value. Import indices never shift
    //      (new late imports append at the end, so indices < importsBefore are
    //      left untouched by every shift walker), so the trampoline still
    //      forwards into the correct import. `getFuncSignature` below resolves
    //      the import's signature, and `call methodFuncIdx` against an import is
    //      valid Wasm. This is EXPECTED — proceed with the normal rebuild.
    //
    //   2. The target was a DEFINED function at registration but now lands in
    //      the import range. That can only mean the late-import shift machinery
    //      missed this entry — a real #1525b regression. Fail loudly rather
    //      than emit invalid Wasm (it would `call` the wrong import).
    if (t.methodFuncIdx < ctx.numImportFuncs && !t.methodTargetsImport) {
      throw new Error(
        `pendingMethodTrampolines: methodFuncIdx ${t.methodFuncIdx} ` +
          `points at import "${ctx.mod.imports[t.methodFuncIdx]?.name}" — ` +
          `shift walker missed this entry (#1525b regression)`,
      );
    }
    const sig = getFuncSignature(ctx, t.methodFuncIdx);
    if (!sig) continue;
    // (#1340) Plain function decls have no hidden `this`; method sigs lead
    // with `this` at param 0 and need it dropped. The legacy method path
    // requires `sig.params.length >= 1` because it slices off `this`.
    if (!t.noThisParam && sig.params.length === 0) continue;
    const methodUserParams = t.noThisParam ? sig.params : sig.params.slice(1);
    // Only rebuild when the user-param arity is unchanged. The trampoline's
    // OWN func type (its wrapper type) was fixed at registration with
    // `userParamCount` params and is shared/cached, so it cannot change here;
    // forwarding a different number of params would violate that contract and
    // produce an invalid `local.get` index. An arity change (e.g. async method
    // param injection) is a separate concern handled by its own codegen path.
    if (methodUserParams.length !== t.userParamCount) continue;

    // (#1669) The trampoline's OWN signature (the wrapper func type, captured
    // when the closure value was emitted) fixes the types of the `local.get`s
    // the forwarding body reads. The method's signature may have been
    // re-resolved during body compilation (default-param / generator / async
    // methods finalize their param types and order then), so the wrapper param
    // types and the method param types can DRIFT — e.g. a default-param method
    // resolves its param to `f64` while the closure-value ABI typed the wrapper
    // param `externref`, or two structurally-deduped sibling literals swap a
    // param's `f64`/`externref` position. Forwarding the wrapper-typed value
    // straight into `call methodFuncIdx` then emits an invalid `call`
    // ("expected externref, found (ref null N)" / "expected externref, found
    // f64"). The same drift can affect the RESULT: the wrapper's declared
    // result is `externref` while the method now returns `(ref null N)`, which
    // shows up as a `fallthru` type error.
    //
    // #1602 introduced this rebuild but forwarded the params verbatim with no
    // coercion, which is correct only when the types did not drift. Re-emit the
    // forwarding with a per-arg coercion from the WRAPPER param type to the
    // METHOD param type, and a final coercion from the method result to the
    // wrapper result, so the rebuilt body validates against both signatures.
    // The wrapper signature is captured at emit time (the static types of the
    // `local.get`s the body reads and the type it must return). Re-deriving it
    // from `t.trampolineFuncIdx` is unsafe: late-import shifting can move that
    // index relative to the recorded value, returning a different function's
    // signature (observed for async methods).
    const wrapperUserParams = t.wrapperUserParams;
    const wrapperResult = t.wrapperResult;
    const methodResult = sig.results[0];

    // Build a minimal FunctionContext so coercions that need a scratch local
    // (externref → ref/ref_null) can allocate one. Its `params` mirror the
    // trampoline's wrapper signature exactly (closure_self at index 0, then the
    // wrapper's user params at 1..N) so `allocTempLocal` computes a temp index
    // past the real params; the allocated `localDefs` are attached to the
    // registered trampoline function below.
    const localDefs: LocalDef[] = [];
    const tFctx: FunctionContext = {
      name: `__obj_meth_tramp_finalize_${t.trampolineFuncIdx}`,
      params: [
        { name: "__self", type: { kind: "anyref" } },
        ...wrapperUserParams.map((p, i) => ({ name: `__p${i}`, type: p })),
      ],
      locals: localDefs,
      localMap: new Map(),
      returnType: wrapperResult ?? null,
      body: [],
      blockDepth: 0,
      breakStack: [],
      continueStack: [],
      labelMap: new Map(),
      savedBodies: [],
    };

    // (#1340) Function-decl trampolines have no `this` prologue; method
    // trampolines resolve the receiver from `__current_this` (#2015, falling
    // back to `ref.null` for the unbound method-extraction case) before
    // forwarding user params. The anyref scratch local is allocated through
    // `tFctx` so it lands in `localDefs` (attached to the registered function
    // below) and any later coercion temps allocate after it.
    let newBody: Instr[];
    if (t.noThisParam) {
      newBody = [];
    } else {
      const anyTempLocalIdx = allocTempLocal(tFctx, { kind: "anyref" });
      // (#2025) Reuse the registration-time `methodUsesThis` (captured before
      // the TypeError-helper import shifted function indices, so it is reliable
      // here where `t.methodFuncIdx` may be stale). Fall back to a fresh body
      // scan only when it wasn't recorded.
      const usesThis = t.methodUsesThis ?? methodBodyReadsThis(ctx, t.methodFuncIdx);
      newBody = buildTrampolineThisSlot(ctx, t.objStructTypeIdx, anyTempLocalIdx, usesThis);
    }
    for (let i = 0; i < methodUserParams.length; i++) {
      newBody.push({ op: "local.get", index: i + 1 } as Instr);
      const from = wrapperUserParams[i];
      const to = methodUserParams[i]!;
      if (from && from.kind !== to.kind) {
        tFctx.body = newBody;
        newBody.push(...coercionInstrs(ctx, from, to, tFctx));
      } else if (
        from &&
        (from.kind === "ref" || from.kind === "ref_null") &&
        (to.kind === "ref" || to.kind === "ref_null")
      ) {
        // Same kind but possibly different struct typeIdx — guarded re-cast.
        const fromIdx = (from as { typeIdx?: number }).typeIdx;
        const toIdx = (to as { typeIdx?: number }).typeIdx;
        if (fromIdx !== toIdx && toIdx !== undefined) {
          tFctx.body = newBody;
          newBody.push(...coercionInstrs(ctx, from, to, tFctx));
        }
      }
    }
    newBody.push({ op: "call", funcIdx: t.methodFuncIdx } as Instr);
    // Reconcile the result arity/type with the wrapper's declared result.
    if (methodResult && !wrapperResult) {
      // Method now returns a value the void wrapper must discard.
      newBody.push({ op: "drop" } as Instr);
    } else if (wrapperResult && methodResult && wrapperResult.kind !== methodResult.kind) {
      tFctx.body = newBody;
      newBody.push(...coercionInstrs(ctx, methodResult, wrapperResult, tFctx));
    } else if (
      wrapperResult &&
      methodResult &&
      (wrapperResult.kind === "ref" || wrapperResult.kind === "ref_null") &&
      (methodResult.kind === "ref" || methodResult.kind === "ref_null") &&
      (wrapperResult as { typeIdx?: number }).typeIdx !== (methodResult as { typeIdx?: number }).typeIdx
    ) {
      // (#1672) Both results are GC struct refs but with DIFFERENT typeIdx.
      // This happens when the wrapper captured the method's result struct type
      // at closure-emit time (`results[0]`), but the method body later resolved
      // its return to a structurally-distinct struct type (e.g. two
      // iterator-result-like struct shapes built at different points — the
      // AsyncFromSyncIterator `next`/`return`/`throw` accessor path). `coercionInstrs`
      // is a NO-OP for same-`kind` operands (`from.kind === to.kind`), so the
      // earlier reliance on it left the body returning `ref methodTypeIdx` where
      // the wrapper's func type declares `ref wrapperTypeIdx` — an invalid module
      // ("fallthru" / result type error compiling `__obj_meth_tramp_*`). Emit an
      // explicit cast to the wrapper's declared result type instead. The cast is
      // routed through `anyref` so it works regardless of whether the two struct
      // types share a supertype (a direct `ref.cast` between unrelated GC types is
      // itself invalid). At runtime the method's generator/iterator-result object
      // is a valid instance of the wrapper's result shape, so the cast succeeds.
      const wrapperTypeIdx = (wrapperResult as { typeIdx: number }).typeIdx;
      if (methodResult.kind === "ref") {
        // Non-null source: cast directly.
        newBody.push({ op: "ref.cast", typeIdx: wrapperTypeIdx } as Instr);
      } else {
        // Nullable source: a null must stay null; cast preserves nullability when
        // the target is also nullable, else guard. Wrapper result kind dictates.
        if (wrapperResult.kind === "ref_null") {
          newBody.push({ op: "ref.cast_null", typeIdx: wrapperTypeIdx } as Instr);
        } else {
          newBody.push({ op: "ref.cast", typeIdx: wrapperTypeIdx } as Instr);
        }
      }
    }

    // Mutate the existing body array in place so the already-registered
    // function keeps the same body reference, and attach any temp locals
    // coercion allocated for this trampoline. The function is located by body
    // identity (not by `trampolineFuncIdx`, which may have shifted): the
    // registered trampoline holds the SAME `t.trampolineBody` array reference.
    //
    // (#2015) The rebuilt body's local indices are computed against `tFctx`,
    // whose `locals` (`localDefs`) start empty — so the `__current_this` anyref
    // scratch lands at the first slot past the wrapper params and any coercion
    // temps after it. The initial emit pre-seeded the function with a single
    // `__this_any` anyref local at that SAME index, so REPLACE the function's
    // locals with `localDefs` (rather than append) to keep the persisted layout
    // in lockstep with the rebuilt body; an append would shift every temp by one.
    if (!t.noThisParam || localDefs.length > 0) {
      const func = ctx.mod.functions.find((f) => f.body === t.trampolineBody);
      if (func) func.locals = localDefs;
    }
    t.trampolineBody.length = 0;
    t.trampolineBody.push(...newBody);
  }
  ctx.pendingMethodTrampolines.length = 0;
}

/**
 * (#1394) Emit a cached singleton closure for a class method, preserving
 * identity: every emit of `C.prototype.<method>` (or `instance.<method>`
 * as a value) returns the same externref so JS's `===` works (e.g.
 * `c.m === C.prototype.m`). 478 tests under
 * `language/{expressions,statements}/class/elements/*` exercise this
 * exact assertion via `verifyProperty(C.prototype, "m", { value: m })`.
 *
 * The cache is a per-class-method module-level externref global,
 * lazily initialised on first access (matches the existing
 * `emitLazyProtoGet` pattern). The canonical trampoline is registered
 * once per method too — its name is
 * `__obj_meth_tramp_${methodName}_cached`, distinct from the legacy
 * per-call-site `__obj_meth_tramp_${methodName}_${counter}` that
 * `emitObjectMethodAsClosure` emits.
 *
 * Returns `true` if the access was emitted; `false` if the method's
 * signature couldn't be resolved (caller should fall back).
 */
export function emitCachedMethodClosureAccess(
  ctx: CodegenContext,
  fctx: FunctionContext,
  methodName: string,
  methodFuncIdx: number,
  objStructTypeIdx: number,
): boolean {
  const singleton = ensureMethodClosureSingleton(ctx, fctx, methodName, methodFuncIdx, objStructTypeIdx);
  if (!singleton) return false;
  const { cacheGlobalIdx, trampolineFuncIdx, closureStructTypeIdx } = singleton;

  // Emit the lazy-init access (mirrors `emitLazyProtoGet`):
  //   global.get $cache
  //   ref.is_null
  //   if (then: build closure, store in $cache)
  //   global.get $cache
  const initBody: Instr[] = [
    { op: "ref.func", funcIdx: trampolineFuncIdx } as Instr,
    { op: "struct.new", typeIdx: closureStructTypeIdx } as Instr,
    { op: "extern.convert_any" } as Instr,
    { op: "global.set", index: cacheGlobalIdx } as Instr,
  ];
  fctx.body.push({ op: "global.get", index: cacheGlobalIdx });
  fctx.body.push({ op: "ref.is_null" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: initBody,
    else: [],
  });
  fctx.body.push({ op: "global.get", index: cacheGlobalIdx });
  return true;
}

/**
 * (#2963) The creation half of {@link emitCachedMethodClosureAccess}, split out
 * so the member-get dispatcher (`member-get-dispatch.ts`) can pre-create the
 * SAME canonical singleton machinery (trampoline + cache global) at reserve
 * time — giving a DYNAMIC `any`-receiver method read (`c.m` where `c: any`)
 * the identical value the typed read (`C.prototype.m`) yields, so
 * `c.m === C.prototype.m` holds. Idempotent per `methodName`.
 *
 * Returns the handles, or `null` when the method signature is unresolvable
 * (caller falls back / skips the candidate). NOTE: `trampolineFuncIdx` and
 * `cacheGlobalIdx` are the CURRENT indices — late imports added after this
 * call shift them. Compile-time callers baking instrs immediately (the typed
 * read) are covered by the body walkers; FINALIZE-time consumers must
 * re-resolve by name (`__obj_meth_tramp_<name>_cached` via funcMap,
 * `ctx.methodClosureGlobals.get(methodName)` — both shift-maintained).
 */
export function ensureMethodClosureSingleton(
  ctx: CodegenContext,
  fctx: FunctionContext,
  methodName: string,
  methodFuncIdx: number,
  objStructTypeIdx: number,
): { cacheGlobalIdx: number; trampolineFuncIdx: number; closureStructTypeIdx: number } | null {
  // Resolve the user-visible signature so we know the wrapper struct's
  // funcref shape. Method signature is [(ref null objStruct), ...userParams]
  // → results; strip the leading `this` to derive the closure-callable
  // user signature.
  const sig = getFuncSignature(ctx, methodFuncIdx);
  if (!sig || sig.params.length === 0) return null;
  const userParams = sig.params.slice(1);
  const results = sig.results;

  const wrapperTypes = getOrCreateFuncRefWrapperTypes(ctx, userParams, results);
  if (!wrapperTypes) return null;
  const { structTypeIdx, liftedFuncTypeIdx } = wrapperTypes;

  // Reuse the canonical trampoline if one was already registered for
  // this method; otherwise build it once.
  const trampolineName = `__obj_meth_tramp_${methodName}_cached`;
  let trampolineFuncIdx = ctx.funcMap.get(trampolineName);
  if (trampolineFuncIdx === undefined) {
    // Trampoline body: drop the closure-self arg (param 0), resolve the
    // method's `this` from `__current_this` (#2015 — falls back to
    // `ref.null` for the unbound method-extraction case `var fn = c.m;
    // fn();` where JS strict mode calls with `this = undefined`, so the
    // null receiver propagates the spec-mandated TypeError on `this.field`
    // access), then forward user params, then call the method.
    const anyTempLocalIdx = 1 + userParams.length;
    // (#2025) Capture this-usage, register the throw helpers, then adjust the
    // forwarding index by any import-shift the registration caused (see the
    // matching note in emitObjectMethodAsClosure).
    const methodUsesThisCached = methodBodyReadsThis(ctx, methodFuncIdx);
    const importsBeforeNT = ctx.numImportFuncs;
    ensureNullThisTypeError(ctx, fctx);
    const ntShift = ctx.numImportFuncs - importsBeforeNT;
    if (ntShift > 0 && inLiveShiftRange(methodFuncIdx, importsBeforeNT)) methodFuncIdx += ntShift;
    const trampolineBody: Instr[] = buildTrampolineThisSlot(
      ctx,
      objStructTypeIdx,
      anyTempLocalIdx,
      methodUsesThisCached,
    );
    for (let i = 0; i < userParams.length; i++) {
      trampolineBody.push({ op: "local.get", index: i + 1 } as Instr);
    }
    trampolineBody.push({ op: "call", funcIdx: methodFuncIdx } as Instr);
    trampolineFuncIdx = mintDefinedFunc(ctx);
    pushDefinedFunc(ctx, trampolineFuncIdx, {
      name: trampolineName,
      typeIdx: liftedFuncTypeIdx,
      locals: [{ name: "__this_any", type: { kind: "anyref" } }],
      body: trampolineBody,
      exported: false,
    });
    ctx.funcMap.set(trampolineName, trampolineFuncIdx);
    ctx.mod.declaredFuncRefs.push(trampolineFuncIdx);

    // (#1669) The method's `func.typeIdx` may still be re-resolved after this
    // first cached access (the method body is compiled later in the same pass,
    // and generator/default-param/async methods finalize their param types and
    // order during that body compile). The trampoline body built above forwards
    // `local.get`s typed by THIS wrapper signature into `call methodFuncIdx`,
    // which validates against the method's FINAL signature. If they drift, the
    // module is invalid. #1602 fixed exactly this for the per-call-site
    // (non-cached) trampoline via `pendingMethodTrampolines`; the cached
    // singleton trampoline was never enrolled, so it kept the stale forwarding.
    // Enroll it so `finalizeMethodTrampolines` rebuilds the body against the
    // method's final signature (with per-arg externref coercion).
    ctx.pendingMethodTrampolines.push({
      trampolineBody,
      trampolineFuncIdx,
      methodFuncIdx,
      objStructTypeIdx,
      userParamCount: userParams.length,
      wrapperUserParams: userParams,
      wrapperResult: results[0],
      methodUsesThis: methodUsesThisCached, // (#2025) captured pre-shift
      // (#1809) See the per-call-site push for rationale.
      methodTargetsImport: methodFuncIdx < ctx.numImportFuncs,
    });
  }

  // Reuse or allocate the cache global. Type is externref so the value
  // is stable across access sites (the closure-struct ref is converted
  // via `extern.convert_any` once at init).
  let cacheGlobalIdx = ctx.methodClosureGlobals.get(methodName);
  if (cacheGlobalIdx === undefined) {
    cacheGlobalIdx = ctx.numImportGlobals + ctx.mod.globals.length;
    ctx.mod.globals.push({
      name: `__method_closure_${methodName}`,
      type: { kind: "externref" },
      mutable: true,
      init: [{ op: "ref.null.extern" }],
    });
    ctx.methodClosureGlobals.set(methodName, cacheGlobalIdx);
  }

  return { cacheGlobalIdx, trampolineFuncIdx, closureStructTypeIdx: structTypeIdx };
}

/**
 * (#1340) Emit a cached singleton closure for a top-level function declaration
 * used as a first-class value. Mirrors `emitCachedMethodClosureAccess` (#1394)
 * for the function-decl case.
 *
 * Without caching, every textual occurrence of `foo` (in value position)
 * compiled a fresh `struct.new $closure_struct`, so `foo === foo` was false
 * and sidecar writes on `foo.prototype` keyed by the struct identity never
 * round-tripped (test262 Iterator helpers misclassified as `wasm_compile`).
 *
 * One externref cache global per function name, lazily initialised on first
 * read; all later reads return the same externref. Call dispatch is unchanged
 * (resolved via `funcMap` + direct `call funcIdx`); only the value-context
 * read uses the cached closure.
 *
 * Only safe for captureless functions — captures must be filled at the
 * per-construction site, not once at module init.
 *
 * Returns the closure struct's `ref` ValType when the cached access was
 * emitted (so downstream consumers like array-methods.ts can take the
 * direct `call_ref` fast path against the closure's funcref slot rather
 * than the externref-bridge slow path through `__call_2_f64`). Returns
 * `null` when the signature couldn't be resolved (caller falls back).
 */
export function emitCachedFuncClosureAccess(
  ctx: CodegenContext,
  fctx: FunctionContext,
  funcName: string,
  funcIdx: number,
): ValType | null {
  const sig = getFuncSignature(ctx, funcIdx);
  if (!sig) return null;

  const userParams = sig.params;
  const results = sig.results;

  const wrapperTypes = getOrCreateFuncRefWrapperTypes(ctx, userParams, results);
  if (!wrapperTypes) return null;
  const { structTypeIdx, liftedFuncTypeIdx } = wrapperTypes;

  // Reuse the canonical trampoline if one was already registered for this
  // function; otherwise build it once.
  const trampolineName = `__fn_tramp_${funcName}_cached`;
  let trampolineFuncIdx = ctx.funcMap.get(trampolineName);
  if (trampolineFuncIdx === undefined) {
    // Forward user params (skip self at param 0) — function declarations
    // don't have a hidden `this` param like methods do.
    const trampolineBody: Instr[] = [];
    for (let i = 0; i < userParams.length; i++) {
      trampolineBody.push({ op: "local.get", index: i + 1 } as Instr);
    }
    trampolineBody.push({ op: "call", funcIdx } as Instr);
    trampolineFuncIdx = mintDefinedFunc(ctx);
    pushDefinedFunc(ctx, trampolineFuncIdx, {
      name: trampolineName,
      typeIdx: liftedFuncTypeIdx,
      locals: [],
      body: trampolineBody,
      exported: false,
    });
    ctx.funcMap.set(trampolineName, trampolineFuncIdx);
    ctx.mod.declaredFuncRefs.push(trampolineFuncIdx);

    // (#1669-style) Mirror the late-finalization guard used by
    // `emitCachedMethodClosureAccess`. The function's `func.typeIdx` may
    // still be re-resolved after this first cached access (default-param /
    // generator funcs finalize param types during body compile). Enroll
    // the trampoline so `finalizeMethodTrampolines` rebuilds the body
    // against the function's final signature.
    ctx.pendingMethodTrampolines.push({
      trampolineBody,
      trampolineFuncIdx,
      methodFuncIdx: funcIdx,
      // No `this` param for a plain function decl — `noThisParam: true`
      // tells the finalizer to skip both the `sig.params.slice(1)` strip
      // and the `ref.null <objStruct>` prologue. `objStructTypeIdx` is
      // unused on this path.
      objStructTypeIdx: -1,
      userParamCount: userParams.length,
      wrapperUserParams: userParams,
      wrapperResult: results[0],
      noThisParam: true,
      // (#1809) A name resolved through `funcMap` can point at a host import
      // (e.g. a DOM/host global `resizeTo`/`scrollBy`, or a `declare`d function)
      // used as a first-class value. The forwarding trampoline legitimately
      // `call`s the import, and import indices never shift, so flag it so the
      // finalizer does not mistake the import target for a missed shift.
      methodTargetsImport: funcIdx < ctx.numImportFuncs,
    });
  }

  // Reuse or allocate the cache global.
  let cacheGlobalIdx = ctx.funcClosureGlobals.get(funcName);
  if (cacheGlobalIdx === undefined) {
    cacheGlobalIdx = ctx.numImportGlobals + ctx.mod.globals.length;
    ctx.mod.globals.push({
      name: `__fn_closure_${funcName}`,
      type: { kind: "externref" },
      mutable: true,
      init: [{ op: "ref.null.extern" }],
    });
    ctx.funcClosureGlobals.set(funcName, cacheGlobalIdx);
  }

  // Emit the lazy-init access (mirrors emitCachedMethodClosureAccess), but
  // recover the closure-struct ref on read so downstream consumers like
  // `array-methods.ts:setupArrayCallback` take the direct `call_ref` fast
  // path. Returning a bare externref forced the host-bridge slow path
  // through `__call_2_f64`, which in JS expects a real Function — array
  // callbacks via top-level fn decls (`[1,2].filter(fn)`) regressed with
  // `TypeError: fn is not a function`. The externref global is preserved
  // for stable cross-site identity (`foo === foo` and sidecar writes on
  // `foo.prototype`); `any.convert_extern + ref.cast` is a cheap, stable
  // bijection back to the struct ref view used by the call-site.
  //   global.get $cache
  //   ref.is_null
  //   if (then: build closure, extern.convert_any, store in $cache)
  //   global.get $cache
  //   any.convert_extern
  //   ref.cast (ref $struct)
  const initBody: Instr[] = [
    { op: "ref.func", funcIdx: trampolineFuncIdx } as Instr,
    { op: "struct.new", typeIdx: structTypeIdx } as Instr,
    { op: "extern.convert_any" } as Instr,
    { op: "global.set", index: cacheGlobalIdx } as Instr,
  ];
  fctx.body.push({ op: "global.get", index: cacheGlobalIdx });
  fctx.body.push({ op: "ref.is_null" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: initBody,
    else: [],
  });
  fctx.body.push({ op: "global.get", index: cacheGlobalIdx });
  fctx.body.push({ op: "any.convert_extern" } as Instr);
  fctx.body.push({ op: "ref.cast", typeIdx: structTypeIdx } as Instr);
  return { kind: "ref", typeIdx: structTypeIdx };
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
