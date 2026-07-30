// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Static eval inlining (#1163).
 *
 * When the argument to `eval(...)` is a compile-time-constant string (a string
 * literal, template literal with no substitutions, or a `+` concatenation of
 * the above), we parse that string as a Script and splice its statements into
 * the current function at compile time — no runtime eval is required.
 *
 * This replaces the dynamic `__extern_eval` host-import call (#1006) for the
 * common literal-argument case.  Per ECMA-262 §19.2.1 PerformEval, the last
 * value produced by the evaluated script becomes the result of the call; if
 * the script does not produce a value (e.g., a var declaration only),
 * `undefined` is returned.
 *
 * Non-literal arguments and parse failures fall through to the existing
 * dynamic-eval path.
 */
import { ts } from "../../ts-api.js";
import type { Instr, ValType } from "../../ir/types.js";
import { allocLocal } from "../context/locals.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { emitVariadicStringConcat, nativeStringRepr } from "../builtin-scaffold.js";
import { emitGlobalEnvironmentObject } from "../global-environment.js";
import { ensureExnTag } from "../registry/imports.js";
import { hoistFunctionDeclarations } from "../statements/nested-declarations.js";
import { hoistLetConstWithTdz, hoistVarDeclarations } from "../index.js";
import type { InnerResult } from "../shared.js";
import { coerceType, compileExpression, compileStatement } from "../shared.js";
import { emitUndefined, ensureLateImport, flushLateImportShifts } from "./late-imports.js";
import { emitFuncRefAsClosure, getFuncSignature } from "../closures.js";
import { compileAndEmitToString } from "../coercion-engine.js";
import { compileStringLiteral } from "../string-ops.js";
import { emitThrowJsError, noJsHost } from "./helpers.js";
import { reportError } from "../context/errors.js";
import { isStrictContext } from "../helpers/is-strict-function.js";
import { foldedEvalEarlyError } from "./eval-early-errors.js";
import { evalAnnexBDeclarationsInlineSupported, hasScriptScopeAnnexBFunction } from "./eval-annexb.js";
import { EVAL_SOURCE_FILENAME } from "./eval-source.js";

/**
 * Recursively resolve a compile-time-constant string from an expression.
 * Returns the string value, or null if the expression is not a constant.
 *
 * (#1102) When a `checker` is supplied, the resolver additionally sees
 * through:
 *   - identifiers bound by a **`const` declaration** whose initializer is
 *     itself a constant string (`const s = "1 + 2"; eval(s)`), guarded by the
 *     execution-order checks in `resolveConstStringBinding` so a fold can
 *     never erase a TDZ `ReferenceError`;
 *   - **template literals with substitutions** where every substitution is a
 *     constant string (`eval(\`1 + ${TWO}\`)`);
 *   - TS-only assertion wrappers (`as` / `satisfies` / `<T>` / `!`).
 * Callers pass the checker only where widening the constant frontier is
 * SOUND: direct eval (the splice's caller-scope semantics are exactly
 * §19.2.1.1 direct-eval semantics) and the `Function` constructor (the
 * synthesized function is global-scoped regardless, §20.2.1.1). Indirect
 * eval must NOT pass a checker — the splice runs in caller scope, which is
 * wrong for indirect eval's global-scope semantics that the dynamic host
 * shim implements correctly (routing rule 2, runtime-eval-interpreter §12).
 */
export function resolveConstantString(expr: ts.Expression, checker?: ts.TypeChecker): string | null {
  return resolveConstantStringDepth(expr, checker, 0);
}

/** Defensive recursion cap for pathological const-reference chains. */
const CONST_STRING_MAX_DEPTH = 16;

function resolveConstantStringDepth(
  expr: ts.Expression,
  checker: ts.TypeChecker | undefined,
  depth: number,
): string | null {
  if (depth > CONST_STRING_MAX_DEPTH) return null;

  // Unwrap parentheses and TS-only assertion wrappers, which have no runtime
  // effect: ("foo"), "foo" as string, "foo" satisfies string, <string>"foo",
  // s! — all evaluate to the inner expression's value.
  let e: ts.Expression = expr;
  for (;;) {
    if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e)) {
      e = e.expression;
    } else if (ts.isSatisfiesExpression(e)) {
      e = e.expression;
    } else if (ts.isTypeAssertionExpression(e)) {
      e = e.expression;
    } else {
      break;
    }
  }

  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) {
    return e.text;
  }

  // String-literal concatenation: "a" + "b", possibly chained.
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = resolveConstantStringDepth(e.left, checker, depth + 1);
    if (left === null) return null;
    const right = resolveConstantStringDepth(e.right, checker, depth + 1);
    if (right === null) return null;
    return left + right;
  }

  // (#1102) Template literal with substitutions: `a${x}b` where every
  // substitution resolves to a constant string.
  if (ts.isTemplateExpression(e)) {
    let out = e.head.text;
    for (const span of e.templateSpans) {
      const sub = resolveConstantStringDepth(span.expression, checker, depth + 1);
      if (sub === null) return null;
      out += sub + span.literal.text;
    }
    return out;
  }

  // (#1102) Identifier bound by a const declaration with a constant-string
  // initializer. Requires the checker (real-SourceFile nodes only — foreign
  // eval-body identifiers never resolve, see EVAL_SOURCE_FILENAME).
  if (checker && ts.isIdentifier(e)) {
    return resolveConstStringBinding(e, checker, depth);
  }

  return null;
}

/**
 * (#1102) Resolve an identifier to a compile-time-constant string through a
 * `const` binding. The value is exactly the initializer's constant value —
 * `const` guarantees no reassignment — but a fold is sound only if the read
 * provably happens AFTER the initializer ran (otherwise it would erase a TDZ
 * `ReferenceError`, changing observable semantics — routing rule 2). Three
 * guards establish execution order statically:
 *
 *   1. **Textual precedence** — the whole declaration statement ends before
 *      the use begins. Also kills self-references and reference cycles (any
 *      cycle needs a backward reference).
 *   2. **Same execution container** — the nearest enclosing function-like
 *      body (or SourceFile / class static block) of use and declaration is
 *      the same node. Without this, a hoisted inner function containing the
 *      use can be invoked before the initializer runs
 *      (`inner(); const s = "…"; function inner() { eval(s); }` — TDZ).
 *   3. **Declaration block is an ancestor of the use** — within one
 *      container, control cannot enter the middle of a block, so reaching a
 *      use nested under a LATER statement of the declaration's own block
 *      implies the declaration executed. Rejects sibling-scope skips like
 *      `switch (x) { case 1: const s = "…"; case 2: eval(s); }` (shared
 *      lexical scope, but case 2 is reachable without running case 1).
 *
 * Only plain `const s = <init>` variable statements qualify — destructuring
 * bindings, `for (const … of …)` heads, imports, and multi-declaration merged
 * symbols are all rejected.
 */
function resolveConstStringBinding(ident: ts.Identifier, checker: ts.TypeChecker, depth: number): string | null {
  let sym: ts.Symbol | undefined;
  try {
    sym = checker.getSymbolAtLocation(ident);
  } catch {
    return null;
  }
  const decls = sym?.declarations;
  if (!decls || decls.length !== 1) return null;
  const decl = decls[0]!;
  if (!ts.isVariableDeclaration(decl) || !ts.isIdentifier(decl.name) || !decl.initializer) return null;

  // Same file only (also excludes .d.ts declarations and foreign eval bodies).
  if (decl.getSourceFile() !== ident.getSourceFile()) return null;

  // `const` only — a `let`/`var` binding can be reassigned after init.
  const declList = decl.parent;
  if (!ts.isVariableDeclarationList(declList) || (ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Const) === 0) {
    return null;
  }
  // Plain variable statement only (not a for-of/for-in/for initializer head —
  // those bind per-iteration).
  const varStmt = declList.parent;
  if (!ts.isVariableStatement(varStmt)) return null;

  // Guard 1: textual precedence.
  if (varStmt.end > ident.getStart()) return null;

  // Guard 2: same execution container — OR the module-top-level relaxation.
  //
  // Same container: statements execute in source order, so precedence (guard
  // 1) + ancestry (guard 3) imply the initializer ran before the read.
  //
  // Relaxation (#1102): when the declaration is a top-level statement of the
  // SourceFile and the use is inside a (possibly nested) function, the read
  // can only happen (a) during module evaluation — where source order rules
  // — or (b) after instantiation, when ALL top-level statements (including
  // the const) have run: exported functions are not callable until the start
  // function completes. The only hazard is a top-level statement BEFORE the
  // const that transfers control into user code (a call/new/getter-read)
  // which could reach the use early — real JS would throw the TDZ
  // `ReferenceError` the fold erases. So the relaxation requires the entire
  // top-level prefix before the declaration to be inert (unable to invoke
  // user code).
  const useContainer = nearestExecutionContainer(ident);
  const declContainer = nearestExecutionContainer(varStmt);
  if (useContainer !== declContainer) {
    if (!ts.isSourceFile(declContainer) || !topLevelPrefixIsInert(declContainer, varStmt)) return null;
    // Fall through: guard 3 is trivially satisfied (the SourceFile is an
    // ancestor of every node in it), but run it anyway for uniformity.
  }

  // Guard 3: the declaration's enclosing block must be an ancestor of the use
  // — within one container, control cannot enter the middle of a block, so a
  // use nested under a LATER statement of the declaration's own block implies
  // the declaration executed. Rejects sibling-scope skips (switch clauses).
  const declBlock: ts.Node = varStmt.parent;
  let anc: ts.Node | undefined = ident.parent;
  while (anc && anc !== declBlock) anc = anc.parent;
  if (anc !== declBlock) return null;

  return resolveConstantStringDepth(decl.initializer, checker, depth + 1);
}

/**
 * (#1102) True when every top-level statement of `sf` strictly before
 * `stopAt` is inert — provably unable to transfer control into user code.
 * Whole-statement allowlist: imports, function declarations, and TS
 * type-space declarations (nothing executes at their site). Variable
 * statements are allowed only when their initializers contain no construct
 * that can invoke user code: calls, `new`, tagged templates, property /
 * element reads (user getters!), `await`, `yield`, decorators. A statement
 * that could only either complete normally or throw is still REJECTED unless
 * allowlisted — conservative simplicity over cleverness (a top-level throw
 * would abort instantiation and make the fold unobservable, but proving
 * "throw-only" per node kind is not worth the audit surface).
 */
function topLevelPrefixIsInert(sf: ts.SourceFile, stopAt: ts.Statement): boolean {
  for (const stmt of sf.statements) {
    if (stmt === stopAt) return true;
    if (
      ts.isImportDeclaration(stmt) ||
      ts.isImportEqualsDeclaration(stmt) ||
      ts.isFunctionDeclaration(stmt) ||
      ts.isInterfaceDeclaration(stmt) ||
      ts.isTypeAliasDeclaration(stmt) ||
      stmt.kind === ts.SyntaxKind.EmptyStatement
    ) {
      continue;
    }
    if (ts.isVariableStatement(stmt) && !containsUserCodeInvoker(stmt)) continue;
    return false;
  }
  // stopAt not found among the top-level statements — shouldn't happen for a
  // top-level declaration; refuse the relaxation.
  return false;
}

/**
 * (#1102) Does the subtree contain any node that can invoke user code when
 * evaluated? (See `topLevelPrefixIsInert`.)
 */
function containsUserCodeInvoker(root: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    switch (n.kind) {
      case ts.SyntaxKind.CallExpression:
      case ts.SyntaxKind.NewExpression:
      case ts.SyntaxKind.TaggedTemplateExpression:
      case ts.SyntaxKind.PropertyAccessExpression:
      case ts.SyntaxKind.ElementAccessExpression:
      case ts.SyntaxKind.AwaitExpression:
      case ts.SyntaxKind.YieldExpression:
      case ts.SyntaxKind.Decorator:
        found = true;
        return;
      // Function bodies inside the initializer (arrow/function expressions)
      // do NOT execute at the declaration site — skip their interiors.
      case ts.SyntaxKind.ArrowFunction:
      case ts.SyntaxKind.FunctionExpression:
        return;
      default:
        n.forEachChild(visit);
    }
  };
  visit(root);
  return found;
}

/**
 * (#1102) The nearest enclosing node that starts a fresh execution sequence:
 * a function-like body, a class static block, or the SourceFile itself.
 * Statements within one container execute in source order; code in a nested
 * container can run at an arbitrary later (or, via hoisting, earlier) time.
 */
function nearestExecutionContainer(n: ts.Node): ts.Node {
  let p: ts.Node | undefined = n.parent;
  while (p) {
    if (
      ts.isFunctionDeclaration(p) ||
      ts.isFunctionExpression(p) ||
      ts.isArrowFunction(p) ||
      ts.isMethodDeclaration(p) ||
      ts.isConstructorDeclaration(p) ||
      ts.isGetAccessorDeclaration(p) ||
      ts.isSetAccessorDeclaration(p) ||
      ts.isClassStaticBlockDeclaration(p) ||
      ts.isSourceFile(p)
    ) {
      return p;
    }
    p = p.parent;
  }
  return n;
}

/**
 * (#3048) True when the parsed eval AST contains an object-literal shape that
 * lowers through the `__make_getter_callback` host bridge in JS-host / GC mode:
 * a get/set accessor, or a computed-property method whose key is not a plain
 * numeric/string literal (the well-known-`Symbol` and runtime-key arms in
 * literals.ts — a plain-literal computed key resolves to a static method name
 * and takes the bridge-free struct path). Mirrors the `collectCallbackImports`
 * detection in declarations.ts so an eval-embedded accessor gets its late import
 * registered before the inline codegen references it.
 */
function evalNeedsGetterCallbackBridge(root: ts.Node): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isObjectLiteralExpression(node)) {
      for (const p of node.properties) {
        if (ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p)) {
          found = true;
          return;
        }
        if (ts.isMethodDeclaration(p) && ts.isComputedPropertyName(p.name)) {
          const inner = p.name.expression;
          if (!(ts.isNumericLiteral(inner) || ts.isStringLiteralLike(inner))) {
            found = true;
            return;
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

/**
 * Try to inline `eval("<constant>")` at compile time.
 *
 * Returns:
 *   - InnerResult (ValType or null) on success — caller treats this as the
 *     compiled call result and does NOT invoke the dynamic-eval fallback.
 *   - undefined if the call is not eligible (non-literal arg, parse errors,
 *     etc.) — caller should fall through to the dynamic-eval path.
 *
 * On success we always push a single externref value onto the stack (the
 * result of the inlined script, coerced to externref to match eval's `any`
 * return type).  When the inlined code is statically unreachable (the last
 * statement is a throw, etc.) we return `null` so the caller knows no value
 * was produced.
 */
export function tryStaticEvalInline(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  /**
   * (#1102) True for DIRECT eval call sites only. Direct eval may widen the
   * constant frontier through `const` string bindings (the splice's
   * caller-scope semantics ARE §19.2.1.1 direct-eval semantics). Indirect
   * eval must not: the splice runs in caller scope, which diverges from
   * indirect eval's global-scope semantics for scope-sensitive bodies that
   * the dynamic host shim handles correctly — so its constant surface stays
   * literal-only (the pre-#1102 status quo).
   */
  allowConstBindings = false,
): InnerResult | undefined {
  if (expr.arguments.length === 0) return undefined;

  // Resolve WITHOUT the checker first so we know whether the constant was
  // reachable pre-#1102 (`widened === false` → status-quo surface) or only
  // through const-binding/template resolution (`widened === true` → newly
  // reachable, held to a stricter bar below).
  let src = resolveConstantString(expr.arguments[0]!);
  let widened = false;
  if (src === null && allowConstBindings) {
    src = resolveConstantString(expr.arguments[0]!, ctx.checker);
    widened = src !== null;
  }
  if (src === null) return undefined;

  // Evaluate any additional arguments for side effects, then drop them.
  // Per §19.2.1, eval only looks at its first argument, but extra args must
  // still be evaluated (they could throw).
  for (let ai = 1; ai < expr.arguments.length; ai++) {
    const t = compileExpression(ctx, fctx, expr.arguments[ai]!);
    if (t !== null) fctx.body.push({ op: "drop" });
  }

  // Parse the eval source as a Script with parent pointers set so the
  // nested codegen paths (which walk upward via node.parent) work.
  const sf = ts.createSourceFile(
    EVAL_SOURCE_FILENAME,
    src,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.JS,
  );

  // If the parse produced diagnostics we're looking at malformed eval source.
  // Real JS would throw SyntaxError at runtime — for now, fall through to the
  // dynamic path so the host can signal the error correctly.  `parseDiagnostics`
  // is an internal field on SourceFile, so access it through a cast.
  const parseDiag = (sf as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics;
  if (parseDiag && parseDiag.length > 0) {
    emitThrowJsError(ctx, fctx, "SyntaxError", "Invalid eval source");
    return { kind: "externref" };
  }

  const stmts = sf.statements;

  // PerformEval parses the string as a fresh Script and applies that Script's
  // early errors before executing any statement. The foreign AST splice used
  // to skip that phase entirely: strict-only names compiled as ordinary
  // identifiers, and an orphan break/continue acquired the CALLER's loop when
  // its statements were spliced there. A direct eval also inherits strictness
  // from its caller; indirect eval does not.
  //
  // Keep this deliberately bounded to the rules needed by the folded surface.
  // Unsupported AST kinds still take allNodesInlineSupported's existing
  // dynamic-eval fallback below.
  const bodyIsStrict = evalBodyHasUseStrictDirective(stmts);
  const evalIsStrict = bodyIsStrict || (allowConstBindings && isStrictContext(expr, ctx.inferModuleStrictArguments));
  const earlyError = foldedEvalEarlyError(sf, evalIsStrict);
  if (earlyError !== undefined) {
    emitThrowJsError(ctx, fctx, "SyntaxError", earlyError);
    return { kind: "externref" };
  }

  // Empty program — eval returns undefined.
  if (stmts.length === 0) {
    emitUndefined(ctx, fctx);
    return { kind: "externref" };
  }

  // Scan the parsed AST for node kinds we cannot safely lower from a foreign
  // SourceFile.  The TypeScript checker has no bindings for nodes created via
  // `ts.createSourceFile`, so anything that requires static type information
  // to compile correctly (function/arrow/class expressions, for-of loops that
  // need iterator types, etc.) would silently mis-compile.  When we detect
  // such a node we bail out and let the dynamic `__extern_eval` path handle
  // the call — correctness first, inlining is a best-effort fast path.
  //
  // A `"use strict"` directive prologue in the eval body switches on
  // strict-mode early-error + strict-name semantics (e.g.
  // `eval("'use strict'; function f(eval){}")` is a SyntaxError; assigning to
  // `eval`/`arguments` throws) that the AST splice does NOT enforce — so
  // function declarations in a strict body keep bailing to the dynamic path
  // (host eval enforces them).  See `allNodesInlineSupported` / #2923 park fix.
  // Duplicate same-name Annex B declarations and same-name lexical
  // declarations require EvalDeclarationInstantiation conflict bookkeeping
  // that the ordinary-source B.3.3 lowering does not reconstruct for a
  // foreign eval AST. Keep those shapes on the existing runtime path.
  if (!evalAnnexBDeclarationsInlineSupported(sf) || !allNodesInlineSupported(sf, bodyIsStrict)) {
    return undefined;
  }

  // (#3301) The foreign-node regex-literal arm defect (dynamic `.flags` read
  // returned undefined because `compileRegExpLiteral` registered `RegExp_new`
  // with a "builtin" intent that resolves to a no-op) is FIXED — the emitter now
  // registers the minimal `externClasses` "RegExp" entry so the resolver routes
  // to the real constructor. So the earlier widened-constant regex bail is gone:
  // a newly-foldable body containing a regex literal inlines correctly.

  // (#3048) The outer-file collection pre-pass (collectCallbackImports) never
  // saw inside this eval SOURCE STRING, so any object-literal getter/setter or
  // bridge-routed computed method it contains has NOT had its
  // `__make_getter_callback` late-import registered — the inline getter/method
  // codegen would then hit a hard CE "Missing __make_getter_callback import"
  // (test262 `language/expressions/object/11.1.5*` compile a `get`/`set`
  // accessor through `eval("o = {get foo(){…}}")`). Register the bridge here,
  // before compiling the spliced statements, and flush the late-import index
  // shift immediately (the `literals.ts` well-known-symbol arm uses the same
  // ensure-then-flush discipline). Host/GC only: under no-JS-host mode the
  // accessor/method lowers to a host-free closure (#1888 S5b / #2194) and must
  // not declare the unsatisfiable `env::` bridge import.
  if (!noJsHost(ctx) && evalNeedsGetterCallbackBridge(sf)) {
    ensureLateImport(ctx, "__make_getter_callback", [{ kind: "i32" }, { kind: "externref" }], [{ kind: "externref" }]);
    flushLateImportShifts(ctx, fctx);
  }

  // Direct eval inherits caller bindings. Indirect eval instead runs in the
  // global environment. The pre-#3633 literal surface already had a known
  // caller-scope approximation; do not widen that approximation to the newly
  // liftable Annex B bodies. Compile those bodies through an isolated binding
  // view so caller locals cannot shadow compiled module/global bindings.
  const isolateIndirectBindings = !allowConstBindings && hasScriptScopeAnnexBFunction(sf);
  return compileInlinedEvalStatements(ctx, fctx, stmts, isolateIndirectBindings);
}

function compileInlinedEvalStatements(
  ctx: CodegenContext,
  fctx: FunctionContext,
  stmts: ts.NodeArray<ts.Statement>,
  isolateBindings: boolean,
): InnerResult | undefined {
  const savedBindingState = isolateBindings
    ? {
        localMap: fctx.localMap,
        boxedCaptures: fctx.boxedCaptures,
        tdzFlagLocals: fctx.tdzFlagLocals,
        boxedTdzFlags: fctx.boxedTdzFlags,
        preHoistedLetConstSlots: fctx.preHoistedLetConstSlots,
        annexBCancelled: fctx.annexBCancelled,
        annexBOuterBindings: fctx.annexBOuterBindings,
      }
    : undefined;

  if (savedBindingState) {
    fctx.localMap = new Map();
    fctx.boxedCaptures = undefined;
    fctx.tdzFlagLocals = undefined;
    fctx.boxedTdzFlags = undefined;
    fctx.preHoistedLetConstSlots = undefined;
    fctx.annexBCancelled = undefined;
    fctx.annexBOuterBindings = undefined;
  }

  try {
    // Hoist var / function declarations before compiling any statements.
    // `let`/`const` enter the block scope in source order.
    try {
      hoistVarDeclarations(ctx, fctx, stmts);
      hoistLetConstWithTdz(ctx, fctx, stmts);
      hoistFunctionDeclarations(ctx, fctx, stmts);
    } catch {
      // If hoisting blows up (e.g. the checker can't type a foreign node),
      // fall back to the dynamic-eval path.
      return undefined;
    }

    // Compile all but the last statement for side effects.
    const lastIdx = stmts.length - 1;
    for (let i = 0; i < lastIdx; i++) {
      compileStatement(ctx, fctx, stmts[i]!);
    }

    const last = stmts[lastIdx]!;

    // ExpressionStatement — the expression's value is the eval result.
    if (ts.isExpressionStatement(last)) {
      const t = compileExpression(ctx, fctx, last.expression);
      if (t === null) {
        // Unreachable (e.g. the expression compiled to a throw).
        return null;
      }
      if (t.kind !== "externref") {
        coerceType(ctx, fctx, t, { kind: "externref" });
      }
      return { kind: "externref" };
    }

    // A non-expression tail returns undefined. A throw leaves the block
    // polymorphic, so the trailing push is dead but keeps stack types stable.
    compileStatement(ctx, fctx, last);
    emitUndefined(ctx, fctx);
    return { kind: "externref" };
  } finally {
    if (savedBindingState) {
      fctx.localMap = savedBindingState.localMap;
      fctx.boxedCaptures = savedBindingState.boxedCaptures;
      fctx.tdzFlagLocals = savedBindingState.tdzFlagLocals;
      fctx.boxedTdzFlags = savedBindingState.boxedTdzFlags;
      fctx.preHoistedLetConstSlots = savedBindingState.preHoistedLetConstSlots;
      fctx.annexBCancelled = savedBindingState.annexBCancelled;
      fctx.annexBOuterBindings = savedBindingState.annexBOuterBindings;
    }
  }
}

/**
 * Walk the parsed eval AST and return false if it contains any node kind that
 * requires TypeScript checker bindings (or binding analysis) we can't provide
 * for foreign nodes.  Currently: function/arrow/class expressions and
 * declarations, for-of loops, yield/await, and dynamic import.  The check is
 * conservative — unsupported constructs simply fall through to runtime eval.
 *
 * `bodyIsStrict` — whether the eval Script begins with a `"use strict"`
 * directive prologue.  A strict eval body has early-error + strict-name
 * semantics the naive splice does NOT enforce, so function declarations in a
 * strict body must keep bailing to the dynamic path (see the `FunctionDeclaration`
 * case below and the #2923 park fix).
 */
export function allNodesInlineSupported(node: ts.Node, bodyIsStrict: boolean): boolean {
  let ok = true;
  const visit = (n: ts.Node): void => {
    if (!ok) return;
    switch (n.kind) {
      // (#2923) Still bail — these need checker bindings the foreign
      // `ts.createSourceFile` lacks, and their codegen THROWS on a binding-less
      // node (an internal error that would fail the whole compile, worse than a
      // clean fall-through to the dynamic path):
      //   - function/arrow EXPRESSIONS + class declarations/expressions resolve
      //     their signature/heritage via the checker (`Cannot read 'escapedName'`).
      //   - yield/await/import/export are out of scope for a Script eval body.
      case ts.SyntaxKind.FunctionExpression:
      case ts.SyntaxKind.ArrowFunction:
      case ts.SyntaxKind.ClassDeclaration:
      case ts.SyntaxKind.ClassExpression:
      case ts.SyntaxKind.YieldExpression:
      case ts.SyntaxKind.AwaitExpression:
      case ts.SyntaxKind.ImportDeclaration:
      case ts.SyntaxKind.ExportDeclaration:
      case ts.SyntaxKind.ExportAssignment:
        ok = false;
        return;
      // (#2923) `for-of` / `for-in` are liftable ONLY when the iterable is a
      // literal whose iteration needs no checker-resolved iterator type — an
      // array/string literal (for-of) or an object/array literal (for-in). A
      // general iterable (a Map/Set/user iterator, or a bare identifier whose
      // type the foreign SourceFile can't resolve) keeps bailing to the dynamic
      // path. When the iterable IS a literal we fall through to recurse into the
      // loop body (which may itself contain a bail node).
      case ts.SyntaxKind.ForOfStatement: {
        if (!isLiftableForOfIterable((n as ts.ForOfStatement).expression)) {
          ok = false;
          return;
        }
        n.forEachChild(visit);
        return;
      }
      case ts.SyntaxKind.ForInStatement: {
        if (!isLiftableForInIterable((n as ts.ForInStatement).expression)) {
          ok = false;
          return;
        }
        n.forEachChild(visit);
        return;
      }
      // (#3633) Sloppy block-nested function declarations are now liftable.
      // The original #2923 guard predated #2200/#2552's Annex B B.3.3
      // outer-binding lifecycle. Hoisting a foreign eval Script now uses that
      // same machinery, preserving both the block binding and the conditional
      // var-scoped outer binding without crossing the host boundary (where
      // compiled module/global bindings are invisible).
      //
      // Strict eval bodies still bail: their strict-name and declaration
      // semantics are not yet fully enforced by the foreign-AST splice.
      // A declaration nested inside another function also stays on the
      // established fallback: #3633 only widens Script-scope Annex B bodies,
      // and the nested declaration has a separate instantiation scope.
      // Nested bail nodes (arrow/class) inside a lifted declaration are still
      // caught by the recursion below.
      case ts.SyntaxKind.FunctionDeclaration: {
        if (bodyIsStrict || functionDeclarationHasFunctionAncestor(n as ts.FunctionDeclaration)) {
          ok = false;
          return;
        }
        n.forEachChild(visit);
        return;
      }
      default:
        n.forEachChild(visit);
    }
  };
  node.forEachChild(visit);
  return ok;
}

function functionDeclarationHasFunctionAncestor(fn: ts.FunctionDeclaration): boolean {
  let parent: ts.Node | undefined = fn.parent;
  while (parent && !ts.isSourceFile(parent)) {
    if (
      ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isArrowFunction(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isConstructorDeclaration(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent)
    ) {
      return true;
    }
    parent = parent.parent;
  }
  return false;
}

/** Unwrap parens to the underlying expression. */
function unwrapParens(e: ts.Expression): ts.Expression {
  let x = e;
  while (ts.isParenthesizedExpression(x)) x = x.expression;
  return x;
}

/**
 * (#2923) A `for-of` iterable is liftable in a foreign eval body when it is an
 * array literal or a string literal — their iteration lowers with no
 * checker-resolved iterator type.
 */
function isLiftableForOfIterable(expr: ts.Expression): boolean {
  const e = unwrapParens(expr);
  return ts.isArrayLiteralExpression(e) || ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e);
}

/**
 * (#2923) A `for-in` iterable is liftable when it is an object or array literal
 * — enumeration walks the literal's own keys / indices without a resolved type.
 */
function isLiftableForInIterable(expr: ts.Expression): boolean {
  const e = unwrapParens(expr);
  return ts.isObjectLiteralExpression(e) || ts.isArrayLiteralExpression(e);
}

/**
 * (#2923 park fix) Does the eval Script begin with a `"use strict"` directive
 * prologue? Per §11.2.1 a directive prologue is the leading run of
 * ExpressionStatements whose expression is a StringLiteral; `"use strict"`
 * anywhere in that run turns the body strict. A strict eval body carries
 * early-error + strict-name semantics (function `eval`/`arguments` params,
 * assignment to `eval`, …) the AST splice does not enforce, so we keep bailing
 * function declarations in such a body to the dynamic host-eval path.
 */
function evalBodyHasUseStrictDirective(stmts: ts.NodeArray<ts.Statement>): boolean {
  for (const s of stmts) {
    if (!ts.isExpressionStatement(s)) break;
    // Only a plain StringLiteral counts as a directive (a template does not).
    if (!ts.isStringLiteral(s.expression)) break;
    if (s.expression.text === "use strict") return true;
    // Some other directive (e.g. "use asm") → keep scanning the prologue.
  }
  return false;
}

/**
 * (#2924) Compile-away `new Function("<params>", …, "<body>")` / the equivalent
 * `Function(...)` call form when every argument is a compile-time-constant
 * string. Slice B of the runtime-eval roadmap (§6-B / §4.4).
 *
 * Per §20.2.1.1 CreateDynamicFunction, the created function's scope is ALWAYS the
 * global environment — it never captures the caller's lexical scope. So when the
 * param list and body are constant, `new Function("a","b","return a+b")` is
 * semantically identical to compiling `function (a,b){ return a+b }` at that site
 * over GLOBAL scope. We synthesize that as a named foreign function declaration,
 * hoist it (reusing the #2923 signature-tolerant path) with the enclosing
 * `localMap` swapped for an empty one (so a body identifier that collides with a
 * caller local resolves as a global, not a capture — the no-capture invariant),
 * then materialize a first-class callable via `emitFuncRefAsClosure`.
 *
 * Returns:
 *   - ValType on success (a callable externref left on the stack),
 *   - undefined to fall through to the existing path (a non-constant argument,
 *     a body that isn't safely liftable, or a synthesis/parse failure — the
 *     dynamic-body case is the Tier-2 interpreter's, #2928).
 */
export function tryStaticNewFunction(
  ctx: CodegenContext,
  fctx: FunctionContext,
  args: readonly ts.Expression[],
): ValType | undefined {
  const synth = synthesizeStaticNewFunction(ctx, fctx, args);
  if (!synth) return undefined;

  // Materialize the callable value (closure struct over the funcref), then wrap
  // to externref to match `new Function`'s `any`/callable result.
  const closureRef = emitFuncRefAsClosure(ctx, fctx, synth.fnName, synth.funcIdx);
  if (!closureRef) {
    fctx.body.push({ op: "ref.null.extern" });
    return { kind: "externref" };
  }
  if (closureRef.kind !== "externref") {
    fctx.body.push({ op: "extern.convert_any" });
  }
  return { kind: "externref" };
}

/**
 * (#2924) Synthesize + hoist the constant-argument `Function(...)` body as a
 * real AOT function over GLOBAL scope. Shared by the value form
 * (`tryStaticNewFunction` → closure materialization) and the direct-call form
 * (`tryStaticFunctionCtorCall` → immediate `call`). Returns the registered
 * name/funcIdx (and the parsed parameter list) — emits NO instructions itself.
 */
function synthesizeStaticNewFunction(
  ctx: CodegenContext,
  fctx: FunctionContext,
  args: readonly ts.Expression[],
): { fnName: string; funcIdx: number; params: readonly ts.ParameterDeclaration[] } | undefined {
  // Every argument must be a compile-time-constant string. A single non-constant
  // arg → dynamic body → fall through (Tier-2 interpreter, #2928).
  // (#1102) Const-binding resolution is always sound here: the synthesized
  // function is GLOBAL-scoped regardless of where the string came from
  // (§20.2.1.1), and the TDZ guards in resolveConstStringBinding apply.
  // Track whether ANY argument needed the checker (`widened`) — newly
  // reachable shapes hold the stricter regex bar below.
  const consts: string[] = [];
  let widened = false;
  for (const a of args) {
    let s = resolveConstantString(a);
    if (s === null) {
      s = resolveConstantString(a, ctx.checker);
      if (s === null) return undefined;
      widened = true;
    }
    consts.push(s);
  }

  // §20.2.1.1.1: the LAST argument is the body; the rest form the parameter list
  // (comma-joined so `("a","b,c","…")` flattens to params a, b, c). No args →
  // `function anonymous() {}` (empty body, empty params).
  const body = consts.length > 0 ? consts[consts.length - 1]! : "";
  const paramSrc = consts.slice(0, -1).join(",");

  // A unique synthesized name; `mod.functions.length` is monotonic within a
  // compile, so two `new Function` sites never collide.
  const fnName = `__new_function_${ctx.mod.functions.length}`;
  const synthSrc = `function ${fnName}(${paramSrc}) {\n${body}\n}`;

  const sf = ts.createSourceFile(
    EVAL_SOURCE_FILENAME,
    synthSrc,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.JS,
  );
  const parseDiag = (sf as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics;
  if (parseDiag && parseDiag.length > 0) {
    // Malformed params/body — real JS throws SyntaxError. Fall through to the
    // existing path rather than force a compile error (the dynamic path / stub
    // preserves current behaviour; strict SyntaxError semantics are #2928).
    return undefined;
  }
  if (sf.statements.length !== 1 || !ts.isFunctionDeclaration(sf.statements[0]!)) return undefined;
  const fnDecl = sf.statements[0] as ts.FunctionDeclaration;

  // (#2923 park-fix parity) A `"use strict"` directive prologue in the
  // synthesized body switches on strict early-errors (`function f(eval){}`,
  // duplicate params, …) the splice does NOT enforce — keep such bodies on the
  // existing fallback path.
  if (fnDecl.body && evalBodyHasUseStrictDirective(fnDecl.body.statements)) return undefined;

  // (#3301) The widened-constant regex bail is gone — the foreign-node
  // regex-literal arm now produces a correct value (see tryStaticEvalInline).

  // (#2924 park fix) A SLOPPY dynamic function's bare call must see
  // `this === globalThis` (§10.4.3 OrdinaryCallBindThis with a non-strict
  // callee), but our splice compiles the body as a free function with
  // `this = undefined` — `Function("return typeof this;")()` returned
  // "undefined" and regressed 4 language/function-code 10.4.3-1-1{3,5}
  // tests in the merge_group. Bail on ANY `this` in the synthesized decl
  // (nested functions included — they share the same wrong binding) so the
  // legacy path keeps the baseline behavior. Diagnosis by the parallel
  // session's [CI-FIX] handoff on PR #2474.
  if (containsThisKeyword(fnDecl)) return undefined;

  // The body must be safely liftable (no function/arrow expression, class, etc.
  // that would need checker bindings the foreign SourceFile lacks — same guard
  // as constant-string eval, #2923). Body is sloppy here (strict bailed above).
  if (!allNodesInlineSupported(fnDecl, /* bodyIsStrict */ false)) return undefined;

  // Hoist + compile the synthesized declaration over GLOBAL scope: swap the
  // enclosing localMap/boxedCaptures for empty ones so the capture analysis in
  // hoistFunctionDeclarations finds nothing to capture (no lexical closure over
  // caller locals, §20.2.1.1). Restore afterwards. Snapshot the module function
  // table so a mid-hoist throw rolls back partially-registered entries instead
  // of leaking them (graft from the closed dup PR #2464).
  const savedLocalMap = fctx.localMap;
  const savedBoxed = fctx.boxedCaptures;
  const savedFuncCount = ctx.mod.functions.length;
  fctx.localMap = new Map();
  fctx.boxedCaptures = undefined;
  try {
    hoistFunctionDeclarations(ctx, fctx, [fnDecl]);
  } catch {
    // Roll back functions registered by the failed hoist + their funcMap keys.
    if (ctx.mod.functions.length > savedFuncCount) {
      ctx.mod.functions.length = savedFuncCount;
      const cutoff = ctx.numImportFuncs + savedFuncCount;
      for (const [name, idx] of ctx.funcMap) {
        if (idx >= cutoff) ctx.funcMap.delete(name);
      }
    }
    return undefined;
  } finally {
    fctx.localMap = savedLocalMap;
    fctx.boxedCaptures = savedBoxed;
  }

  const funcIdx = ctx.funcMap.get(fnName);
  if (funcIdx === undefined) return undefined;

  return { fnName, funcIdx, params: fnDecl.parameters };
}

/** (#2924 park fix) Does the node tree contain a `this` expression? */
function containsThisKeyword(root: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (n.kind === ts.SyntaxKind.ThisKeyword) {
      found = true;
      return;
    }
    n.forEachChild(visit);
  };
  visit(root);
  return found;
}

/**
 * (#2924) Resolve whether an identifier named `Function` refers to the global
 * `Function` intrinsic (declared only in `.d.ts`) rather than a local shadow.
 * Mirrors `isGlobalEvalIdentifier` (eval-tiering.ts / calls.ts).
 */
export function isGlobalFunctionIdentifier(ident: ts.Identifier, checker: ts.TypeChecker): boolean {
  if (ident.text !== "Function") return false;
  const sym = checker.getSymbolAtLocation(ident);
  if (!sym) return true; // unresolved → assume the global
  const decls = sym.declarations;
  if (!decls || decls.length === 0) return true;
  return decls.every((d) => d.getSourceFile().isDeclarationFile);
}

/** Unwrap parens around an expression (local copy of the calls.ts idiom). */
function unwrapParenExpr(e: ts.Expression): ts.Expression {
  let x = e;
  while (ts.isParenthesizedExpression(x)) x = x.expression;
  return x;
}

/**
 * (#2924) Early guard for `compileCallExpression` — covers the two call-shapes
 * of the constant `Function` compile-away:
 *
 *  1. **Value form** `Function("<const>", …)` (plain call, §20.2.1.1: identical
 *     to `new Function(...)`): synthesize and push the callable closure.
 *  2. **Immediate-call form** `new Function(...)(args)` / `Function(...)(args)`:
 *     the callee itself is the ctor expression. We know the synthesized
 *     funcIdx, so emit a DIRECT `call` with the outer args marshalled to the
 *     synthesized signature (all-externref params / externref result, the
 *     #2923 foreign-tolerance shape): coerce args, pad missing with
 *     `undefined`, evaluate-and-drop extras (JS §7.3.14 arity semantics).
 *     This bypasses the generic any-callee dispatch, which does not currently
 *     route a NewExpression callee.
 *
 * Returns undefined to fall through to the existing paths (non-constant args,
 * local `Function` shadow, unsupported body, non-plain params, …).
 */
/**
 * (#2960) True when `expr` is the IMMEDIATE-CALL form of a Function constructor
 * — `new Function(...)(args)` or `Function(...)(args)` — targeting the GLOBAL
 * `Function` intrinsic. Used by the host-mode dynamic path: when the constant
 * compile-away (`tryStaticFunctionCtorCall`) declines (non-constant args), the
 * callee compiles to the meta-circular shim's real host-callable value, so the
 * outer call routes through `__call_function` (a wasm-side `f(...)` on a plain
 * host-function externref otherwise returns undefined — the general any-callee
 * host-function limitation). Only meaningful in JS-host mode.
 */
export function isFunctionCtorImmediateCall(expr: ts.CallExpression, checker: ts.TypeChecker): boolean {
  const callee = unwrapParenExpr(expr.expression);
  if (ts.isNewExpression(callee)) {
    const target = unwrapParenExpr(callee.expression);
    return ts.isIdentifier(target) && isGlobalFunctionIdentifier(target, checker);
  }
  if (ts.isCallExpression(callee) && !callee.questionDotToken) {
    const target = unwrapParenExpr(callee.expression);
    return ts.isIdentifier(target) && isGlobalFunctionIdentifier(target, checker);
  }
  return false;
}

export function tryStaticFunctionCtorCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
): InnerResult | undefined {
  const callee = unwrapParenExpr(expr.expression);

  // Shape 1: `Function("...")` — plain-call value form.
  if (ts.isIdentifier(callee) && isGlobalFunctionIdentifier(callee, ctx.checker)) {
    return tryStaticNewFunction(ctx, fctx, expr.arguments);
  }

  // Shape 2: immediate call — callee is `new Function(...)` or `Function(...)`.
  let ctorArgs: readonly ts.Expression[] | undefined;
  if (ts.isNewExpression(callee)) {
    const target = unwrapParenExpr(callee.expression);
    if (ts.isIdentifier(target) && isGlobalFunctionIdentifier(target, ctx.checker)) {
      ctorArgs = callee.arguments ?? [];
    }
  } else if (ts.isCallExpression(callee) && !callee.questionDotToken) {
    const target = unwrapParenExpr(callee.expression);
    if (ts.isIdentifier(target) && isGlobalFunctionIdentifier(target, ctx.checker)) {
      ctorArgs = callee.arguments;
    }
  }
  if (ctorArgs === undefined) return undefined;

  const synth = synthesizeStaticNewFunction(ctx, fctx, ctorArgs);
  if (!synth) return undefined;

  // Direct-call fast path only for PLAIN identifier params (no defaults /
  // destructuring / rest — those need the optional-param sentinel machinery).
  for (const p of synth.params) {
    if (!ts.isIdentifier(p.name) || p.initializer || p.dotDotDotToken) return undefined;
  }

  // Marshal against the REAL reserved signature: foreign-tolerant hoisting
  // usually degrades params/result to externref, but a simple body (e.g.
  // `return 42`) can still checker-resolve to f64 — never assume externref.
  const sig = getFuncSignature(ctx, synth.funcIdx);
  if (!sig) return undefined;
  const paramCount = sig.params.length;
  const callArgs = expr.arguments;

  // Pre-scan: every formal beyond the provided args must be paddable BEFORE
  // any instruction is emitted (a mid-marshal bail would strand operands).
  for (let i = callArgs.length; i < paramCount; i++) {
    const k = sig.params[i]!.kind;
    if (k !== "externref" && k !== "f64") return undefined;
  }

  // Marshal min(A,P) args in order (coerced to the formal's type), pad missing
  // with `undefined` (NaN in an f64 formal — undefined ToNumber), then evaluate
  // extras for side effects and drop them (JS §7.3.14 arity semantics).
  for (let i = 0; i < paramCount; i++) {
    const pType = sig.params[i]!;
    if (i < callArgs.length) {
      compileExpression(ctx, fctx, callArgs[i]!, pType);
    } else if (pType.kind === "externref") {
      emitUndefined(ctx, fctx);
    } else {
      fctx.body.push({ op: "f64.const", value: Number.NaN });
    }
  }
  for (let i = paramCount; i < callArgs.length; i++) {
    const t = compileExpression(ctx, fctx, callArgs[i]!);
    if (t !== null) fctx.body.push({ op: "drop" });
  }
  // (#2924 park fix) Re-fetch the funcIdx AFTER the arg compiles: any arg
  // expression can trigger addUnionImports, which shifts function indices —
  // the index captured at synthesis time goes stale and the emitted `call`
  // targets the wrong function (the host-mode 3-arg wrong-value/invalid-Wasm
  // finding in the #2474 [CI-FIX] handoff). funcMap auto-shifts, so it is
  // the authoritative source at emit time.
  // (Args are already on the stack here — never bail past this point. The
  // funcMap entry cannot vanish, but keep the synthesis-time index as a
  // defensive fallback rather than stranding operands.)
  const liveIdx = ctx.funcMap.get(synth.fnName) ?? synth.funcIdx;
  fctx.body.push({ op: "call", funcIdx: liveIdx });
  const resType = sig.results.length > 0 ? sig.results[0]! : null;
  if (resType === null) {
    // Void result — a JS call still evaluates to `undefined`.
    emitUndefined(ctx, fctx);
    return { kind: "externref" };
  }
  if (resType.kind !== "externref") {
    coerceType(ctx, fctx, resType, { kind: "externref" });
  }
  return { kind: "externref" };
}

/** Dynamic `Function(...)` call form (without `new`) for standalone. */
export function tryStandaloneDynamicFunctionCtorValue(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
): InnerResult | undefined {
  if (!ctx.standalone) return undefined;
  const callee = unwrapParenExpr(expr.expression);
  if (!ts.isIdentifier(callee) || !isGlobalFunctionIdentifier(callee, ctx.checker)) return undefined;
  return emitStandaloneDynamicFunctionRuntime(ctx, fctx, expr.arguments);
}

/**
 * (#2960) DIAGNOSTIC message shared by every dynamic-code fall-through so the
 * standalone warning and the call-time throw name the same tracking goal.
 */
const DYNAMIC_CODE_UNSUPPORTED_MSG =
  "dynamic code evaluation (eval / new Function with a non-constant body) is not " +
  "supported in --target standalone/wasi — no runtime-eval host is available " +
  "(tracking: runtime-eval goal, bytecode interpreter #2928)";

/** Core-Wasm provider namespace owned by #2928/#2527. */
export const RUNTIME_EVAL_IMPORT_MODULE = "js2wasm:runtime-eval";

/**
 * Unwrap the provider's `[ok, value]` result vector. A provider-side throw uses
 * that vector because Wasm exception tags are module instances, not
 * structurally canonical values: throwing the provider's private tag directly
 * cannot be caught by the user module. Re-throwing `value` through the caller's
 * own tag restores ordinary AOT try/catch behavior. The vector is intentional:
 * unlike a source-inferred plain object, the canonical externref vec carrier is
 * structurally shared by both modules.
 */
function emitRuntimeEvalResultUnwrap(ctx: CodegenContext, fctx: FunctionContext): ValType {
  const envelopeLocal = allocLocal(fctx, `__runtime_eval_result_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: envelopeLocal });

  const externref: ValType = { kind: "externref" };
  const getIdx = ensureLateImport(ctx, "__extern_get_idx", [externref, { kind: "f64" }], [externref]);
  const truthyIdx = ensureLateImport(ctx, "__is_truthy", [externref], [{ kind: "i32" }]);
  flushLateImportShifts(ctx, fctx);
  const liveGetIdx = ctx.funcMap.get("__extern_get_idx") ?? getIdx;
  const liveTruthyIdx = ctx.funcMap.get("__is_truthy") ?? truthyIdx;
  if (liveGetIdx === undefined || liveTruthyIdx === undefined) {
    fctx.body.push({ op: "ref.null.extern" });
    return externref;
  }

  const getField = (index: 0 | 1): Instr[] => [
    { op: "local.get", index: envelopeLocal },
    { op: "f64.const", value: index },
    { op: "call", funcIdx: liveGetIdx },
  ];
  const value = getField(1);
  const thrown = [...getField(1), { op: "throw", tagIdx: ensureExnTag(ctx) } satisfies Instr];

  fctx.body.push(...getField(0), { op: "call", funcIdx: liveTruthyIdx });
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: externref },
    then: value,
    else: thrown,
  });
  return externref;
}

/**
 * Standalone indirect eval route. Direct eval remains on #2929 because it
 * requires caller-scope reification; indirect eval is always global-scoped and
 * can execute entirely inside the separately linked interpreter provider.
 */
export function emitStandaloneIndirectEvalRuntime(
  ctx: CodegenContext,
  fctx: FunctionContext,
  args: readonly ts.Expression[],
): ValType | undefined {
  if (!ctx.standalone) return undefined;
  if (args.length === 0) {
    fctx.body.push({ op: "ref.null.extern" });
    return { kind: "externref" };
  }

  const sourceType = compileExpression(ctx, fctx, args[0]!);
  if (sourceType && sourceType.kind !== "externref") {
    coerceType(ctx, fctx, sourceType, { kind: "externref" });
  }
  for (let i = 1; i < args.length; i++) {
    const extraType = compileExpression(ctx, fctx, args[i]!);
    if (extraType !== null) fctx.body.push({ op: "drop" });
  }
  if (emitGlobalEnvironmentObject(ctx, fctx) === null) {
    fctx.body.push({ op: "ref.null.extern" });
  }

  const evalIdx = ensureLateImport(
    ctx,
    "__runtime_indirect_eval",
    [{ kind: "externref" }, { kind: "externref" }],
    [{ kind: "externref" }],
    RUNTIME_EVAL_IMPORT_MODULE,
  );
  flushLateImportShifts(ctx, fctx);
  if (evalIdx === undefined) {
    fctx.body.push({ op: "drop" }, { op: "ref.null.extern" });
    return { kind: "externref" };
  }
  const liveIdx = ctx.funcMap.get("__runtime_indirect_eval") ?? evalIdx;
  fctx.body.push({ op: "call", funcIdx: liveIdx });
  return emitRuntimeEvalResultUnwrap(ctx, fctx);
}

/**
 * Standalone dynamic `new Function` route. The parser/interpreter lives in a
 * separately compiled core-Wasm provider, so the user module keeps only one
 * link-time import and no JavaScript host dependency.
 */
export function emitStandaloneDynamicFunctionRuntime(
  ctx: CodegenContext,
  fctx: FunctionContext,
  args: readonly ts.Expression[],
): ValType | undefined {
  if (!ctx.standalone) return undefined;
  const repr = nativeStringRepr(ctx);
  if (repr === undefined) return undefined;
  if (!ensureRuntimeEvalCallableCarrier(ctx, fctx)) return undefined;

  const liveParts: Instr[][] = [];
  const compilePart = (arg: ts.Expression): Instr[] => {
    const part: Instr[] = [];
    ctx.liveBodies.add(part);
    liveParts.push(part);
    const savedBody = fctx.body;
    fctx.body = part;
    try {
      let tsType: ts.Type;
      try {
        tsType = ctx.checker.getTypeAtLocation(arg);
      } catch {
        tsType = ctx.checker.getTypeAtLocation(arg.parent ?? arg);
      }
      const stringType = compileAndEmitToString(ctx, fctx, arg, tsType, "string");
      if (stringType.kind !== "externref" && stringType.kind !== "ref" && stringType.kind !== "ref_null") {
        coerceType(ctx, fctx, stringType, repr.resultType, "string");
      }
    } finally {
      fctx.body = savedBody;
    }
    return part;
  };

  // §20.2.1.1.1: the final argument is the body; preceding arguments are
  // ToString-coerced and comma-joined in source order.
  const numParams = Math.max(0, args.length - 1);
  const paramParts: Instr[][] = [];
  for (let i = 0; i < numParams; i++) {
    if (i > 0) paramParts.push(repr.literal(","));
    paramParts.push(compilePart(args[i]!));
  }
  fctx.body.push(...(paramParts.length === 0 ? repr.literal("") : emitVariadicStringConcat(repr, paramParts)), {
    op: "extern.convert_any",
  });

  if (args.length === 0) {
    fctx.body.push(...repr.literal(""), { op: "extern.convert_any" });
  } else {
    fctx.body.push(...compilePart(args[args.length - 1]!), { op: "extern.convert_any" });
  }
  if (emitGlobalEnvironmentObject(ctx, fctx) === null) {
    fctx.body.push({ op: "ref.null.extern" });
  }

  const newFnIdx = ensureLateImport(
    ctx,
    "__runtime_new_function",
    [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
    [{ kind: "externref" }],
    RUNTIME_EVAL_IMPORT_MODULE,
  );
  flushLateImportShifts(ctx, fctx);
  for (const part of liveParts) ctx.liveBodies.delete(part);
  if (newFnIdx === undefined) {
    fctx.body.push({ op: "drop" }, { op: "drop" }, { op: "ref.null.extern" });
    return { kind: "externref" };
  }
  const liveIdx = ctx.funcMap.get("__runtime_new_function") ?? newFnIdx;
  fctx.body.push({ op: "call", funcIdx: liveIdx });
  return emitRuntimeEvalResultUnwrap(ctx, fctx);
}

/**
 * Register the exact eight-slot callable root used by `makeInterpClosure`.
 * Core-Wasm canonicalizes structurally equal recursive types only when both
 * modules contain the matching group; without this local seed the dynamic
 * callable classifier treats the provider's returned closure as non-callable.
 */
export function ensureRuntimeEvalCallableCarrier(ctx: CodegenContext, fctx: FunctionContext): boolean {
  if (ctx.runtimeEvalCallableSeeded) return true;
  const fnName = `__runtime_eval_callable_seed_${ctx.mod.functions.length}`;
  const synthSrc = `function ${fnName}(a0, a1, a2, a3, a4, a5, a6, a7) { ` + `return a0; }`;
  const sf = ts.createSourceFile(
    EVAL_SOURCE_FILENAME,
    synthSrc,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.JS,
  );
  if (sf.statements.length !== 1 || !ts.isFunctionDeclaration(sf.statements[0]!)) return false;
  const fnDecl = sf.statements[0] as ts.FunctionDeclaration;

  const savedLocalMap = fctx.localMap;
  const savedBoxed = fctx.boxedCaptures;
  const savedFuncCount = ctx.mod.functions.length;
  fctx.localMap = new Map();
  fctx.boxedCaptures = undefined;
  try {
    hoistFunctionDeclarations(ctx, fctx, [fnDecl]);
  } catch {
    if (ctx.mod.functions.length > savedFuncCount) {
      ctx.mod.functions.length = savedFuncCount;
      const cutoff = ctx.numImportFuncs + savedFuncCount;
      for (const [name, idx] of ctx.funcMap) {
        if (idx >= cutoff) ctx.funcMap.delete(name);
      }
    }
    return false;
  } finally {
    fctx.localMap = savedLocalMap;
    fctx.boxedCaptures = savedBoxed;
  }

  const funcIdx = ctx.funcMap.get(fnName);
  if (funcIdx === undefined) return false;
  const closureRef = emitFuncRefAsClosure(ctx, fctx, fnName, funcIdx);
  if (!closureRef) return false;
  fctx.body.push({ op: "drop" });
  ctx.runtimeEvalCallableSeeded = true;
  return true;
}

/**
 * (#2960) Host-mode DYNAMIC `new Function(p0, …, pN, body)` — route to the
 * meta-circular runtime-eval machinery via the `env::__extern_new_function`
 * host shim (`createNewFunctionShim`, the same `compileSourceSync` + LRU-cache
 * machinery indirect eval uses). `new Function` is global-scoped (§20.2.1.1),
 * so the shim compiles a fresh global-scope module and returns a real
 * JS-callable function value (unlike the eval path, whose child-module closure
 * the parent can't cast/invoke).
 *
 * We build TWO runtime strings — a comma-joined `paramString` and the
 * `bodyString` — by ToString-coercing each argument and (for ≥2 params)
 * joining with `__concat_N`, then call `__extern_new_function(params, body)`.
 * Replaces the silent `ref.null.extern` no-op stub for the dynamic-arg cluster
 * (the constant-arg compile-away #2924 runs first).
 *
 * Returns `undefined` (caller falls through) when the shim path is unavailable:
 * no-JS-host (`standalone`/`wasi`, handled by the throwing stub instead) or
 * `nativeStrings` (js-string concat isn't wired there).
 */
export function emitDynamicNewFunctionHostEval(
  ctx: CodegenContext,
  fctx: FunctionContext,
  args: readonly ts.Expression[],
): ValType | undefined {
  if (noJsHost(ctx) || ctx.nativeStrings) return undefined;

  const emitArgToString = (a: ts.Expression): void => {
    let tsType: ts.Type;
    try {
      tsType = ctx.checker.getTypeAtLocation(a);
    } catch {
      tsType = ctx.checker.getTypeAtLocation(a.parent ?? a);
    }
    compileAndEmitToString(ctx, fctx, a, tsType, "string");
  };

  // ── paramString: the first k-1 args, comma-joined (empty when 0 params). ──
  const numParams = Math.max(0, args.length - 1);
  if (numParams === 0) {
    compileStringLiteral(ctx, fctx, "");
  } else if (numParams === 1) {
    emitArgToString(args[0]!);
  } else {
    let pieces = 0;
    for (let i = 0; i < numParams; i++) {
      if (i > 0) {
        compileStringLiteral(ctx, fctx, ",");
        pieces++;
      }
      emitArgToString(args[i]!);
      pieces++;
    }
    const concatParams: ValType[] = Array.from({ length: pieces }, () => ({ kind: "externref" }) as ValType);
    const concatIdx = ensureLateImport(ctx, `__concat_${pieces}`, concatParams, [{ kind: "externref" }]);
    flushLateImportShifts(ctx, fctx);
    if (concatIdx === undefined) {
      // Unwind the pushed pieces conservatively — bail to the null stub.
      for (let i = 0; i < pieces; i++) fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "ref.null.extern" });
      return { kind: "externref" };
    }
    fctx.body.push({ op: "call", funcIdx: concatIdx });
  }

  // ── bodyString: the last arg (empty when there are no args at all). ──
  if (args.length >= 1) {
    emitArgToString(args[args.length - 1]!);
  } else {
    compileStringLiteral(ctx, fctx, "");
  }

  // ── __extern_new_function(paramString, bodyString) → callable externref. ──
  const newFnIdx = ensureLateImport(
    ctx,
    "__extern_new_function",
    [{ kind: "externref" }, { kind: "externref" }],
    [{ kind: "externref" }],
  );
  flushLateImportShifts(ctx, fctx);
  if (newFnIdx === undefined) {
    fctx.body.push({ op: "drop" });
    fctx.body.push({ op: "drop" });
    fctx.body.push({ op: "ref.null.extern" });
    return { kind: "externref" };
  }
  fctx.body.push({ op: "call", funcIdx: newFnIdx });
  return { kind: "externref" };
}

/**
 * (#2960) No-JS-host (`standalone`/`wasi`) DYNAMIC `new Function` — replace the
 * silent `ref.null.extern` stub with a callable value that throws a CATCHABLE
 * error at call time, plus a source-located compile-time warning. Construction
 * still succeeds, so a program that never CALLS the constructed function keeps
 * working; only invoking it raises (`dynamic code evaluation not supported`).
 *
 * Implemented by hoisting a zero-parameter synthesized function whose body
 * throws, then materializing it as a no-capture closure value. Falls back to a
 * bare throw expression (still catchable) if the synthesis fails, so the result
 * is never a silent wrong value again.
 */
export function emitStandaloneDynamicFunctionStub(
  ctx: CodegenContext,
  fctx: FunctionContext,
  node: ts.Node,
  args: readonly ts.Expression[],
): ValType {
  // Source-located warning (non-fatal — informational channel, #1921).
  reportError(ctx, node, `Warning: ${DYNAMIC_CODE_UNSUPPORTED_MSG}`, "warning");

  // Per spec the argument expressions are evaluated (for side effects) at
  // construction. Preserve that before materializing the stub value.
  for (const arg of args) {
    const t = compileExpression(ctx, fctx, arg);
    if (t !== null) fctx.body.push({ op: "drop" });
  }

  const stub = synthesizeThrowingFunctionStub(ctx, fctx);
  if (stub !== undefined) {
    const closureRef = emitFuncRefAsClosure(ctx, fctx, stub.fnName, stub.funcIdx);
    if (closureRef) {
      if (closureRef.kind !== "externref") fctx.body.push({ op: "extern.convert_any" });
      return { kind: "externref" };
    }
  }
  // Synthesis unavailable — degrade to the previous null-value stub (still no
  // silent wrong-VALUE regression relative to main; the warning was emitted).
  fctx.body.push({ op: "ref.null.extern" });
  return { kind: "externref" };
}

/**
 * (#2960) Hoist a zero-parameter `function __dyn_fn_stub_<idx>() { throw new
 * Error(...); }` over GLOBAL scope (no captures) and return its funcIdx. Reuses
 * the same synthesized-declaration hoist machinery as
 * `synthesizeStaticNewFunction`. Returns `undefined` if the hoist fails.
 */
function synthesizeThrowingFunctionStub(
  ctx: CodegenContext,
  fctx: FunctionContext,
): { fnName: string; funcIdx: number } | undefined {
  const fnName = `__dyn_fn_stub_${ctx.mod.functions.length}`;
  const synthSrc = `function ${fnName}() { throw new Error(${JSON.stringify(DYNAMIC_CODE_UNSUPPORTED_MSG)}); }`;

  const sf = ts.createSourceFile(
    EVAL_SOURCE_FILENAME,
    synthSrc,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.JS,
  );
  if (sf.statements.length !== 1 || !ts.isFunctionDeclaration(sf.statements[0]!)) return undefined;
  const fnDecl = sf.statements[0] as ts.FunctionDeclaration;

  const savedLocalMap = fctx.localMap;
  const savedBoxed = fctx.boxedCaptures;
  const savedFuncCount = ctx.mod.functions.length;
  fctx.localMap = new Map();
  fctx.boxedCaptures = undefined;
  try {
    hoistFunctionDeclarations(ctx, fctx, [fnDecl]);
  } catch {
    if (ctx.mod.functions.length > savedFuncCount) {
      ctx.mod.functions.length = savedFuncCount;
      const cutoff = ctx.numImportFuncs + savedFuncCount;
      for (const [name, idx] of ctx.funcMap) {
        if (idx >= cutoff) ctx.funcMap.delete(name);
      }
    }
    return undefined;
  } finally {
    fctx.localMap = savedLocalMap;
    fctx.boxedCaptures = savedBoxed;
  }

  const funcIdx = ctx.funcMap.get(fnName);
  if (funcIdx === undefined) return undefined;
  return { fnName, funcIdx };
}
