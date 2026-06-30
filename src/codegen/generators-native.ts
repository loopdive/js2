// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Wasm-native generator lowering (#680).
 *
 * No-JS-host state-machine path for `function*` declarations. The body is
 * decomposed into a flat list of **states**; each `yield` is a suspension
 * checkpoint that spills live locals into a WasmGC state struct and returns a
 * `{value, done}` result. `next()` re-enters a generated resume function at the
 * saved state.
 *
 * Phase 1 (#1665) handled a linear sequence of sequential numeric yields with
 * an optional numeric `return`.
 *
 * Phase 2 (#2079) adds yields inside structured control flow — `while` / `for`
 * / `do-while` loops and `if` / `else` — by lowering each construct to states
 * with explicit successor-state transitions and driving them with a trampoline:
 * the resume function wraps the state dispatch in a `loop`, a yield/return
 * `br`s out producing the result, and a non-yielding transition (loop back-edge,
 * if-join, sequential boundary) sets the state field and `br`s back to the
 * dispatch top to re-enter at the new state within the same `next()` call.
 *
 * Constraints kept for this slice (bail to the scoped diagnostic / host path):
 *   - yielded expressions and spilled locals are numeric (f64);
 *   - `yield*`, `break`/`continue` targeting a yield-loop, `switch`/labeled
 *     statements with yields, and `try/catch` with yields are not modeled
 *     (try/finally without catch is, as in Phase 1).
 */
import { ts } from "../ts-api.js";
import { isBooleanType, isNumberType, isStringType, mapTsTypeToWasm } from "../checker/type-mapper.js";
import type { FieldDef, Instr, ValType, WasmFunction } from "../ir/types.js";
import { allocLocal } from "./context/locals.js";
import { popBody, pushBody } from "./context/bodies.js";
import type { CodegenContext, FunctionContext, NativeGeneratorInfo } from "./context/types.js";
import { reportError } from "./context/errors.js";
import { nativeStringType } from "./native-strings.js";
import { emitBrandCheckTypeError } from "./native-proto.js";
import { addFuncType } from "./registry/types.js";
import { coerceType, compileExpression, compileStatement, valTypesMatch } from "./shared.js";
import { bodyUsesArguments } from "./helpers/body-uses-arguments.js";
import { resolveSpillLocalValType } from "./statements/variables.js";
import { ensureExnTag } from "./registry/imports.js";

const STATE_FIELD = 0;
const SENT_FIELD = 1;
const MODE_FIELD = 2;
const ABRUPT_FIELD = 3;
// (#2864 F2) `gen.throw(e)` error payload. Always externref (an Error object),
// independent of the carrier — the `abrupt`/`sent` carrier fields can be f64 in a
// numeric generator, so the thrown value needs its own slot. Resume mode 2 reads
// it and re-throws after running enclosing finalizers.
const ERROR_FIELD = 4;
const RESULT_VALUE_FIELD = 0;
const RESULT_DONE_FIELD = 1;
const PARAM_FIELD_OFFSET = 5;
// Resume modes stored in MODE_FIELD: 0 = next, 1 = return (abrupt), 2 = throw.
const MODE_NEXT = 0;
const MODE_RETURN = 1;
const MODE_THROW = 2;
const MAX_NATIVE_GENERATOR_STATES = 256;

/**
 * Terminator of a generator state — what happens after the state's straight-line
 * prelude statements run.
 *
 *  - `yield`   suspend: emit the yielded value as `{value, done:0}`, set the
 *              state to `next` and return to the caller.
 *  - `return`  complete with a value: `{value, done:1}`.
 *  - `done`    complete with no value: `{undefined, done:1}`.
 *  - `jump`    transfer control to state `next` WITHOUT suspending (loop
 *              back-edge / if-join / sequential boundary) — re-enters the
 *              trampoline in the same `next()` call.
 *  - `branch`  evaluate a numeric condition; if truthy jump to `thenState`,
 *              else jump to `elseState`. No suspension.
 */
type StateTerminator =
  | { kind: "yield"; expr: ts.Expression | undefined; next: number }
  | { kind: "return"; expr: ts.Expression | undefined }
  | { kind: "done" }
  | { kind: "jump"; next: number }
  | { kind: "branch"; cond: ts.Expression; negate: boolean; thenState: number; elseState: number }
  // (#2170) `yield* <inner-generator-call>` — delegate to an inner native
  // generator. `subject` is the inner generator call expression; `innerName` is
  // the callee's source name (resolved to a `NativeGeneratorInfo` at emit time).
  // `siteIndex` keys the per-delegation `ref null $InnerState` slot allocated in
  // the state struct (see `delegationSites`). This is a SELF-suspending state:
  // each `.next()` re-enters it, driving the inner's resume until the inner is
  // done, then control transfers to `next`.
  | { kind: "yield-star"; subject: ts.Expression; innerName: string; siteIndex: number; next: number };

interface NativeGeneratorState {
  /** Straight-line, yield-free statements to run on entering this state. */
  statements: ts.Statement[];
  /**
   * Local names bound from the `.next(value)` argument on resume into this
   * state (the suspended `let x = yield …` target).
   */
  resumeBindings: string[];
  /**
   * Active `finally` blocks (innermost last) whose statements run on a
   * `GeneratorResumeAbrupt` (`.return()`) hitting the yield that leads here.
   */
  abruptResume?: { finalizers: readonly ts.Statement[][] };
  terminator: StateTerminator;
}

interface NativeGeneratorPlan {
  states: NativeGeneratorState[];
  spills: string[];
  /**
   * (#2864 F1b) The wasm ValType for each spilled local, keyed by name. A local
   * carried across a `yield` gets a state-struct field at its ACTUAL type
   * (object → `ref_null $Object`, string → the native-string ref, number → f64),
   * not the historical f64. A `let x = yield …` resume binding takes the carrier
   * (`sent`-field) type. Every spill resolves to a supported kind or the plan
   * bails to the host path (see `buildNativeGeneratorPlan`).
   */
  spillTypes: Map<string, ValType>;
  /** (#2171) Uniform yield element ValType — f64 (numeric) or native string. */
  elemValType: ValType;
  /**
   * (#2170) One entry per `yield*` delegation site, in `siteIndex` order. The
   * inner generator's source name lets the resume emitter resolve its
   * `NativeGeneratorInfo` at emit time; `buildResumeInfo` allocates one
   * `ref null $InnerState` field per entry to persist the inner iterator across
   * the outer generator's host re-entries.
   */
  delegationSites: { innerName: string }[];
}

function noJsHostTarget(ctx: CodegenContext): boolean {
  return ctx.standalone || ctx.wasi;
}

function sanitizeTypeName(name: string): string {
  return name.replace(/[^A-Za-z0-9_$]/g, "_");
}

function isNumericExpression(ctx: CodegenContext, expr: ts.Expression | undefined): boolean {
  if (!expr) return true;
  const t = ctx.checker.getTypeAtLocation(expr);
  return isNumberType(t) || isBooleanType(t);
}

// (#2171) Native-string yield support. A yield expression qualifies for the
// string-payload path when its static type is a string and the target lowers
// strings to the native `$AnyString` ref (standalone / nativeStrings). The
// generator-wide elem type is decided up-front (generatorElemValType): all
// numeric → f64 (the default path), all string → the native string ref,
// anything else / mixed → unsupported (bail to the #680 diagnostic).
function isStringYieldExpression(ctx: CodegenContext, expr: ts.Expression | undefined): boolean {
  if (!expr) return false;
  if (!(ctx.nativeStrings && ctx.anyStrTypeIdx >= 0)) return false;
  return isStringType(ctx.checker.getTypeAtLocation(expr));
}

/**
 * Decide a generator's uniform yield element ValType. Walks every `yield` in
 * the body (not descending into nested functions).
 *
 *  - all-numeric (or zero-yield) → `{kind:"f64"}` (the historical fast path);
 *  - all-string → the native `$AnyString` ref (#2171);
 *  - anything else (object yields, or a MIX of numeric/string/object) →
 *    `{kind:"externref"}`, the universal boxed-`any` carrier (#2864 F1). Every
 *    JS value coerces to externref host-free in standalone/WASI (numbers via the
 *    native `__box_number`, objects/strings via `extern.convert_any`), so the
 *    heterogeneous frame needs no host import. This is the seam that unblocks
 *    object/mixed-yield generators that previously bailed to the eager-buffer
 *    host path (and thus refused under standalone).
 *
 * Never returns null now — the externref carrier subsumes the formerly-bailing
 * cases; zero-yield generators are rejected separately by the plan builder.
 */
function generatorElemValType(ctx: CodegenContext, decl: GeneratorDecl): ValType {
  let sawNumeric = false;
  let sawString = false;
  let sawOther = false;
  const visit = (node: ts.Node): void => {
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node)
    ) {
      return; // a yield here belongs to an inner generator
    }
    if (ts.isYieldExpression(node) && !node.asteriskToken) {
      if (isNumericExpression(ctx, node.expression)) sawNumeric = true;
      else if (isStringYieldExpression(ctx, node.expression)) sawString = true;
      else sawOther = true;
    }
    ts.forEachChild(node, visit);
  };
  if (decl.body) visit(decl.body);
  // Uniform numeric (or no yields): the f64 fast path, byte-identical to before.
  if (!sawOther && !sawString) return { kind: "f64" };
  // Uniform string: the native-string carrier (#2171), byte-identical to before.
  if (!sawOther && !sawNumeric && sawString) return nativeStringType(ctx);
  // Heterogeneous (object and/or mixed types): the boxed-any externref carrier.
  return { kind: "externref" };
}

/** True when a generator uses the boxed-`any` externref carrier (#2864 F1). */
function carrierIsAny(elemValType: ValType): boolean {
  return elemValType.kind === "externref";
}

/**
 * The ValType of the per-frame `sent` / `abrupt` scalar fields. For the boxed-any
 * carrier these hold a boxed `any` (externref) so `.next(v)` / `.return(v)` carry
 * an arbitrary value; for the numeric & string carriers they stay f64 (a
 * `.next(v)`/`.return(v)` argument coerces to f64, byte-identical to pre-#2864).
 */
function genCarrierFieldType(elemValType: ValType): ValType {
  return carrierIsAny(elemValType) ? { kind: "externref" } : { kind: "f64" };
}

function statementContainsYield(stmt: ts.Statement): boolean {
  return nodeContainsYield(stmt);
}

/**
 * A `return` anywhere in this statement (not descending into nested functions).
 * Used to route `if`/loops that contain a `return` through the structural
 * lowering even when they have no yield — a `return` inside a generator must
 * produce `{value, done:true}`, NOT a raw wasm `return` (which `compileStatement`
 * would emit, mis-coercing the value to the resume function's result-ref type).
 */
function statementContainsReturn(stmt: ts.Statement): boolean {
  let found = false;
  function visit(node: ts.Node): void {
    if (found) return;
    if (ts.isReturnStatement(node)) {
      found = true;
      return;
    }
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node)
    ) {
      return;
    }
    ts.forEachChild(node, visit);
  }
  ts.forEachChild(stmt, visit);
  return found;
}

/** Statement needs structural state-graph lowering (vs straight-line prelude). */
function statementNeedsStructuralLowering(stmt: ts.Statement): boolean {
  if (statementContainsYield(stmt)) return true;
  // A bare/top-level `return` is handled by the caller's `return` terminator;
  // but a `return` nested inside control flow needs structural lowering so it
  // still maps to a generator-completion terminator.
  if (!ts.isReturnStatement(stmt) && statementContainsReturn(stmt)) return true;
  return false;
}

function nodeContainsYield(root: ts.Node): boolean {
  let found = false;
  function visit(node: ts.Node): void {
    if (found) return;
    if (ts.isYieldExpression(node)) {
      found = true;
      return;
    }
    // Do not descend into nested function bodies — a `yield` there belongs to
    // a different (inner) generator and must not split this one.
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node)
    ) {
      return;
    }
    ts.forEachChild(node, visit);
  }
  ts.forEachChild(root, visit);
  return found;
}

/**
 * Plan builder. Walks the generator body producing a state graph. Returns
 * `null` when any shape is outside the supported subset, so callers fall back
 * to the host path (or the scoped diagnostic in standalone).
 */
function buildNativeGeneratorPlan(ctx: CodegenContext, decl: GeneratorDecl): NativeGeneratorPlan | null {
  if (!decl.body) return null;

  // (#2171/#2864) Decide the uniform yield element type up-front. Numeric → f64
  // (the historical path); all-string → native string ref; mixed / object →
  // the boxed-any externref carrier. `yieldValueOk` then gates each per-yield
  // check on that decision: a string yield is accepted only in a string-typed
  // generator, a numeric yield only in a numeric one, and ANY yield is accepted
  // in the boxed-any carrier (every value coerces to externref).
  const elemValType = generatorElemValType(ctx, decl);
  const elemIsString = elemValType.kind === "ref" || elemValType.kind === "ref_null";
  const elemIsAny = carrierIsAny(elemValType);
  const yieldValueOk = (expr: ts.Expression | undefined): boolean =>
    elemIsAny ? true : elemIsString ? isStringYieldExpression(ctx, expr) : isNumericExpression(ctx, expr);

  const states: NativeGeneratorState[] = [];
  const spills: string[] = [];
  // (#2170) `yield*` delegation sites, allocated in source order; index into
  // this array is the terminator's `siteIndex`.
  const delegationSites: { innerName: string }[] = [];
  const spillSet = new Set<string>();
  // (#2864 F1b) The variable declaration that introduced each spilled name, so
  // the spill's wasm type can be resolved at its actual ValType.
  const spillDecls = new Map<string, ts.VariableDeclaration>();
  const addSpill = (name: string, decl?: ts.VariableDeclaration): void => {
    if (decl !== undefined && !spillDecls.has(name)) spillDecls.set(name, decl);
    if (spillSet.has(name)) return;
    spillSet.add(name);
    spills.push(name);
  };

  // Builder is structured as a recursive lowering over the statement list with
  // an explicit "current state being filled" cursor. Because Wasm has no goto,
  // we model control flow with state ids resolved up-front: we reserve a state
  // id, then fill it.
  let ok = true;

  // The state currently being constructed: its prelude statements + pending
  // resume bindings / abrupt-resume context.
  let curStatements: ts.Statement[] = [];
  let curResumeBindings: string[] = [];
  let curAbrupt: NativeGeneratorState["abruptResume"] | undefined;
  let curUsed = false; // becomes the id below once we know it

  // Reserve the state id for the in-progress state.
  let curId = reserveState();

  function reserveState(): number {
    const id = states.length;
    // Placeholder; filled by finishState. Marked with a sentinel terminator.
    states.push({
      statements: [],
      resumeBindings: [],
      terminator: { kind: "done" },
    });
    return id;
  }

  function startState(): number {
    curStatements = [];
    curResumeBindings = [];
    curAbrupt = undefined;
    curUsed = false;
    return reserveState();
  }

  function finishState(id: number, terminator: StateTerminator): void {
    states[id] = {
      statements: curStatements,
      resumeBindings: curResumeBindings,
      abruptResume: curAbrupt,
      terminator,
    };
  }

  const tryYieldDeclaration = (stmt: ts.Statement): { name: string; yieldExpr: ts.YieldExpression } | null => {
    if (!ts.isVariableStatement(stmt)) return null;
    if (stmt.declarationList.declarations.length !== 1) return null;
    const declStmt = stmt.declarationList.declarations[0]!;
    if (!ts.isIdentifier(declStmt.name)) return null;
    if (!declStmt.initializer || !ts.isYieldExpression(declStmt.initializer)) return null;
    return { name: declStmt.name.text, yieldExpr: declStmt.initializer };
  };

  const statementsAreYieldFree = (statements: readonly ts.Statement[]): boolean =>
    statements.every((stmt) => !statementContainsYield(stmt));

  /**
   * Lower a list of statements into the state graph, threading the "current
   * state" cursor. Each `yield` closes the current state with a yield
   * terminator pointing at a freshly-reserved successor and continues filling
   * that successor. Loops/ifs containing yields reserve their header / branch
   * states and wire jumps. Returns false (sets ok=false) on unsupported shapes.
   *
   * `activeFinalizers` carries enclosing try/finally bodies for abrupt-resume.
   */
  function lowerStatements(statements: readonly ts.Statement[], activeFinalizers: readonly ts.Statement[][]): boolean {
    for (const stmt of statements) {
      if (!ok) return false;
      if (stmt.kind === ts.SyntaxKind.EmptyStatement) continue;

      // A top-level `return` always terminates the current state. (Routed here
      // first so a bare `return expr;` is a completion terminator, not a raw
      // wasm `return` from compileStatement.)
      if (ts.isReturnStatement(stmt)) {
        // (#2171) The return *value* must match the generator's yield element
        // type (numeric or string); a bare `return;` (no expr) is allowed.
        if (stmt.expression && !yieldValueOk(stmt.expression)) return fail();
        collectSpillsIn(stmt);
        finishState(curId, { kind: "return", expr: stmt.expression });
        // Unreachable tail — start a fresh (dead) state so the cursor stays
        // valid; it will simply never be entered.
        curId = startState();
        // Statements after an unconditional return are dead.
        return true;
      }

      // Straight-line statement (no yield, no nested return): append to the
      // current state's prelude and let compileStatement emit it verbatim.
      if (!statementNeedsStructuralLowering(stmt)) {
        collectSpillsIn(stmt);
        curStatements.push(stmt);
        continue;
      }

      // Statement that CONTAINS a yield somewhere — must be modeled.
      // 1) `yield expr;` as an expression statement.
      if (ts.isExpressionStatement(stmt) && ts.isYieldExpression(stmt.expression)) {
        if (!emitYield(stmt.expression, undefined, activeFinalizers)) return false;
        continue;
      }

      // 2) `let x = yield expr;`
      const yd = tryYieldDeclaration(stmt);
      if (yd) {
        if (!emitYield(yd.yieldExpr, yd.name, activeFinalizers)) return false;
        continue;
      }

      // 3) try/finally (no catch) wrapping yields.
      if (ts.isTryStatement(stmt)) {
        if (stmt.catchClause || !stmt.finallyBlock) return fail();
        if (!statementsAreYieldFree(stmt.finallyBlock.statements)) return fail();
        if (!lowerStatements(stmt.tryBlock.statements, [...activeFinalizers, [...stmt.finallyBlock.statements]])) {
          return false;
        }
        // finally runs on the normal path too.
        for (const f of stmt.finallyBlock.statements) {
          collectSpillsIn(f);
          curStatements.push(f);
        }
        continue;
      }

      // 4) if / else with yields in a branch.
      if (ts.isIfStatement(stmt)) {
        if (!lowerIf(stmt, activeFinalizers)) return false;
        continue;
      }

      // 5) while / do-while / for loops with yields in the body.
      if (ts.isWhileStatement(stmt)) {
        if (!lowerWhile(stmt, activeFinalizers)) return false;
        continue;
      }
      if (ts.isDoStatement(stmt)) {
        if (!lowerDoWhile(stmt, activeFinalizers)) return false;
        continue;
      }
      if (ts.isForStatement(stmt)) {
        if (!lowerFor(stmt, activeFinalizers)) return false;
        continue;
      }

      // 6) A bare block with yields — flatten it (no new scope modeling).
      if (ts.isBlock(stmt)) {
        if (!lowerStatements(stmt.statements, activeFinalizers)) return false;
        continue;
      }

      return fail();
    }
    return ok;
  }

  function fail(): boolean {
    ok = false;
    return false;
  }

  /** Close the current state at a yield and continue in a fresh successor. */
  function emitYield(
    yieldExpr: ts.YieldExpression,
    bindSentTo: string | undefined,
    activeFinalizers: readonly ts.Statement[][],
  ): boolean {
    // (#2170) `yield* <inner-generator-call>` — delegate to an inner native
    // generator. Slice-1 supports a direct call to a native-generator function
    // declaration (`yield* inner()`); anything else (arbitrary iterable, the
    // value of `yield*` consumed, a non-native inner) still bails to the host
    // path / scoped diagnostic.
    if (yieldExpr.asteriskToken) {
      const subject = yieldExpr.expression;
      const innerName = subject ? nativeGeneratorDelegationName(subject) : undefined;
      if (!subject || innerName === undefined) return fail();
      // The successor after delegation finishes. Like a yield successor it may
      // carry a resume binding (`x = yield* inner()` binds the inner's return
      // value); slice-1 supports only the unbound expression-statement form, so
      // require `bindSentTo === undefined`.
      if (bindSentTo !== undefined) return fail();
      const siteIndex = delegationSites.length;
      delegationSites.push({ innerName });
      const nextId = startStateAfterYield(undefined, activeFinalizers);
      finishState(curId, {
        kind: "yield-star",
        subject,
        innerName,
        siteIndex,
        next: nextId,
      });
      // Create the successor and make it current (mirrors finishCurrentAsYield).
      curId = reserveState();
      curStatements = [];
      curResumeBindings = pendingResumeBindings;
      curAbrupt = pendingAbrupt;
      pendingResumeBindings = [];
      pendingAbrupt = undefined;
      return ok;
    }
    // (#2171) yieldValueOk admits the f64 numeric path AND the uniform
    // native-string path; mixed/object yields still bail.
    if (!yieldValueOk(yieldExpr.expression)) return fail();
    const next = startStateAfterYield(bindSentTo, activeFinalizers);
    // The state we were filling (curIdBefore) is finished by startStateAfterYield's
    // caller — handled inside helper to keep ids tidy.
    finishCurrentAsYield(yieldExpr.expression, next, activeFinalizers, bindSentTo);
    return ok;
  }

  /**
   * (#2170) If `expr` is a direct call to a native-generator function
   * declaration (`inner()` where `function* inner(){…}`), return the callee's
   * source name; else undefined. Resolution to the inner's `NativeGeneratorInfo`
   * is deferred to emit time (the inner may not be registered yet during the
   * candidate pre-pass), so here we only confirm the callee is a zero-host
   * native generator declaration.
   */
  function nativeGeneratorDelegationName(expr: ts.Expression): string | undefined {
    if (!ts.isCallExpression(expr)) return undefined;
    if (expr.arguments.length !== 0) return undefined; // slice-1: no-arg inner call
    // TS CallExpression's callee is `.expression`.
    const callee = expr.expression;
    if (!ts.isIdentifier(callee)) return undefined;
    const sym = ctx.checker.getSymbolAtLocation(callee);
    const innerDecl = sym?.declarations?.find((d): d is ts.FunctionDeclaration => ts.isFunctionDeclaration(d));
    if (!innerDecl || !innerDecl.asteriskToken || !innerDecl.body) return undefined;
    if (!isNativeGeneratorCandidate(ctx, innerDecl)) return undefined;
    // (#2170 slice-1 / #2171 interop) Only numeric (f64) inner generators are
    // delegated. The per-elemType result struct (#2171) means a string inner
    // (`__NativeGeneratorResult_str`) and a numeric outer
    // (`__NativeGeneratorResult_f64`) would mismatch when the yield-star arm
    // re-yields `innerRes.value` through the OUTER result struct. Same-elemType
    // string delegation is a follow-up; for now bail to the host path.
    const innerElem = generatorElemValType(ctx, innerDecl);
    if (innerElem === null || innerElem.kind !== "f64") return undefined;
    return callee.text;
  }

  // Reserve the successor of a yield and set up its resume binding/abrupt
  // context, returning its id.
  let pendingResumeBindings: string[] = [];
  let pendingAbrupt: NativeGeneratorState["abruptResume"] | undefined;
  function startStateAfterYield(bindSentTo: string | undefined, activeFinalizers: readonly ts.Statement[][]): number {
    pendingResumeBindings = bindSentTo ? [bindSentTo] : [];
    pendingAbrupt = { finalizers: [...activeFinalizers].reverse() };
    if (bindSentTo) addSpill(bindSentTo);
    return states.length; // successor id (reserved inside finishCurrentAsYield)
  }

  function finishCurrentAsYield(
    expr: ts.Expression | undefined,
    nextId: number,
    _activeFinalizers: readonly ts.Statement[][],
    _bindSentTo: string | undefined,
  ): void {
    finishState(curId, { kind: "yield", expr, next: nextId });
    // Now actually create the successor and make it current.
    curId = reserveState();
    curStatements = [];
    curResumeBindings = pendingResumeBindings;
    curAbrupt = pendingAbrupt;
    pendingResumeBindings = [];
    pendingAbrupt = undefined;
  }

  /** if (cond) thenBlock [else elseBlock] — at least one branch yields. */
  function lowerIf(stmt: ts.IfStatement, activeFinalizers: readonly ts.Statement[][]): boolean {
    if (!isNumericExpression(ctx, stmt.expression)) return fail();
    collectSpillsIn(stmt.expression);
    // Close current state with a branch terminator. Reserve the join state and
    // the branch entry states.
    const branchHostId = curId;

    // Reserve then-entry, else-entry, join.
    const thenEntry = reserveState();
    const hasElse = !!stmt.elseStatement;
    const elseEntry = hasElse ? reserveState() : -1;
    const joinId = reserveState();

    finishState(branchHostId, {
      kind: "branch",
      cond: stmt.expression,
      negate: false,
      thenState: thenEntry,
      elseState: hasElse ? elseEntry : joinId,
    });

    // Lower then-branch starting at thenEntry.
    curId = thenEntry;
    curStatements = [];
    curResumeBindings = [];
    curAbrupt = undefined;
    if (!lowerStatements(thenBody(stmt.thenStatement), activeFinalizers)) return false;
    finishState(curId, { kind: "jump", next: joinId });

    if (hasElse) {
      curId = elseEntry;
      curStatements = [];
      curResumeBindings = [];
      curAbrupt = undefined;
      if (!lowerStatements(thenBody(stmt.elseStatement!), activeFinalizers)) return false;
      finishState(curId, { kind: "jump", next: joinId });
    }

    // Continue in the join state.
    curId = joinId;
    curStatements = [];
    curResumeBindings = [];
    curAbrupt = undefined;
    return ok;
  }

  /** while (cond) body — body yields. */
  function lowerWhile(stmt: ts.WhileStatement, activeFinalizers: readonly ts.Statement[][]): boolean {
    if (!isNumericExpression(ctx, stmt.expression)) return fail();
    if (loopBodyHasUnsupportedJump(stmt.statement)) return fail();
    collectSpillsIn(stmt.expression);

    // Current state jumps to the header.
    const headerId = reserveState();
    finishState(curId, { kind: "jump", next: headerId });

    // header: branch on cond → bodyEntry / exit
    const bodyEntry = reserveState();
    const exitId = reserveState();
    states[headerId] = {
      statements: [],
      resumeBindings: [],
      terminator: { kind: "branch", cond: stmt.expression, negate: false, thenState: bodyEntry, elseState: exitId },
    };

    // body: lower, then jump back to header.
    curId = bodyEntry;
    curStatements = [];
    curResumeBindings = [];
    curAbrupt = undefined;
    if (!lowerStatements(thenBody(stmt.statement), activeFinalizers)) return false;
    finishState(curId, { kind: "jump", next: headerId });

    // continue at exit.
    curId = exitId;
    curStatements = [];
    curResumeBindings = [];
    curAbrupt = undefined;
    return ok;
  }

  /** do body while (cond) — body runs at least once, then header. */
  function lowerDoWhile(stmt: ts.DoStatement, activeFinalizers: readonly ts.Statement[][]): boolean {
    if (!isNumericExpression(ctx, stmt.expression)) return fail();
    if (loopBodyHasUnsupportedJump(stmt.statement)) return fail();
    collectSpillsIn(stmt.expression);

    const bodyEntry = reserveState();
    finishState(curId, { kind: "jump", next: bodyEntry });

    const headerId = reserveState();
    const exitId = reserveState();

    // body → header
    curId = bodyEntry;
    curStatements = [];
    curResumeBindings = [];
    curAbrupt = undefined;
    if (!lowerStatements(thenBody(stmt.statement), activeFinalizers)) return false;
    finishState(curId, { kind: "jump", next: headerId });

    // header: cond ? bodyEntry : exit
    states[headerId] = {
      statements: [],
      resumeBindings: [],
      terminator: { kind: "branch", cond: stmt.expression, negate: false, thenState: bodyEntry, elseState: exitId },
    };

    curId = exitId;
    curStatements = [];
    curResumeBindings = [];
    curAbrupt = undefined;
    return ok;
  }

  /** for (init; cond; update) body — body yields. */
  function lowerFor(stmt: ts.ForStatement, activeFinalizers: readonly ts.Statement[][]): boolean {
    if (loopBodyHasUnsupportedJump(stmt.statement)) return fail();
    // init: a yield-free var-decl list or expression; append to current state.
    if (stmt.initializer) {
      if (ts.isVariableDeclarationList(stmt.initializer)) {
        // Only numeric simple declarations.
        for (const d of stmt.initializer.declarations) {
          if (!ts.isIdentifier(d.name)) return fail();
          if (d.initializer && statementContainsYield(d.initializer as unknown as ts.Statement)) return fail();
          addSpill(d.name.text);
        }
        // Wrap into a synthetic VariableStatement so compileStatement handles it.
        const vs = ts.factory.createVariableStatement(undefined, stmt.initializer);
        curStatements.push(vs);
      } else {
        if (nodeContainsYield(stmt.initializer)) return fail();
        curStatements.push(ts.factory.createExpressionStatement(stmt.initializer));
      }
    }

    const cond = stmt.condition;
    if (cond && !isNumericExpression(ctx, cond)) return fail();
    if (cond) collectSpillsIn(cond);

    const headerId = reserveState();
    finishState(curId, { kind: "jump", next: headerId });

    const bodyEntry = reserveState();
    const updateId = reserveState();
    const exitId = reserveState();

    states[headerId] = {
      statements: [],
      resumeBindings: [],
      terminator: cond
        ? { kind: "branch", cond, negate: false, thenState: bodyEntry, elseState: exitId }
        : { kind: "jump", next: bodyEntry },
    };

    // body → update
    curId = bodyEntry;
    curStatements = [];
    curResumeBindings = [];
    curAbrupt = undefined;
    if (!lowerStatements(thenBody(stmt.statement), activeFinalizers)) return false;
    finishState(curId, { kind: "jump", next: updateId });

    // update → header
    if (stmt.incrementor) {
      if (nodeContainsYield(stmt.incrementor)) return fail();
      collectSpillsIn(stmt.incrementor);
    }
    states[updateId] = {
      statements: stmt.incrementor ? [ts.factory.createExpressionStatement(stmt.incrementor)] : [],
      resumeBindings: [],
      terminator: { kind: "jump", next: headerId },
    };

    curId = exitId;
    curStatements = [];
    curResumeBindings = [];
    curAbrupt = undefined;
    return ok;
  }

  // Conservatively spill every simple numeric local declared / assigned in the
  // generator body, since loops re-enter states across suspensions and the live
  // local set is hard to compute precisely. Identifiers that are params are
  // already in the state struct.
  function collectSpillsIn(node: ts.Node): void {
    function visit(n: ts.Node): void {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) {
        addSpill(n.name.text, n);
      }
      if (
        ts.isFunctionDeclaration(n) ||
        ts.isFunctionExpression(n) ||
        ts.isArrowFunction(n) ||
        ts.isMethodDeclaration(n)
      ) {
        return;
      }
      ts.forEachChild(n, visit);
    }
    visit(node);
  }

  // Pre-scan the whole body so every loop-carried / yield-crossing local is a
  // spill field BEFORE states are emitted (a state entered on resume reads all
  // spills from the struct, so any local mutated across a suspension must be a
  // spill regardless of which state declared it).
  collectSpillsIn(decl.body);

  if (!lowerStatements(decl.body.statements, [])) return null;
  if (!ok) return null;

  // Final fallthrough state completes the generator.
  finishState(curId, { kind: "done" });

  // Reject if there is no actual suspension point (then it's not a generator
  // worth the native path) or the state count is too large. (#2170) A
  // `yield*` delegation state is a suspension point too.
  const suspendCount = states.filter((s) => s.terminator.kind === "yield" || s.terminator.kind === "yield-star").length;
  if (suspendCount === 0) return null;
  if (states.length > MAX_NATIVE_GENERATOR_STATES) return null;

  // (#2864 F1b) Type every spilled local at its ACTUAL wasm ValType so a live-
  // across-yield object / string / typed-struct local survives the frame, rather
  // than the F1 blanket bail (`elemIsAny && spills.length > 0`) or the historical
  // f64-only assumption. Two kinds of spill:
  //   • a `let x = yield …` RESUME BINDING — its value comes from the `sent`
  //     carrier field, so it must match the carrier type (f64 for numeric/string,
  //     externref for the boxed-any carrier), NOT resolveWasmType(x) (the declared
  //     `TNext`, usually `any`).
  //   • a plain body LOCAL — resolved via `resolveSpillLocalValType`, which mirrors
  //     the type the resume function's var-declaration will assign it.
  // If ANY spill cannot be resolved to a supported, struct-storable kind, the
  // whole generator bails to the host path (return null) — consistent across the
  // candidate gate and registration (both route through this builder), so the
  // host imports stay registered and no undefined funcidx is baked.
  const resumeBindingNames = new Set<string>();
  for (const s of states) for (const b of s.resumeBindings) resumeBindingNames.add(b);
  const carrierType = genCarrierFieldType(elemValType);
  const spillTypes = new Map<string, ValType>();
  for (const name of spills) {
    if (resumeBindingNames.has(name)) {
      // A `let x = yield …` binding reads `.next(v)`'s value from the `sent`
      // carrier field. For numeric / native-string carriers (sent = f64 / string)
      // this round-trips and was already supported. For the BOXED-ANY carrier the
      // sent value is an externref whose later member reads need the any-receiver
      // dispatch (#2151) — not yet correct here (it silently computes a wrong
      // value), so keep bailing that shape to the host path, exactly as F1 did.
      if (carrierIsAny(elemValType)) return null;
      spillTypes.set(name, carrierType);
      continue;
    }
    const declNode = spillDecls.get(name);
    const resolved = declNode ? resolveSpillLocalValType(ctx, declNode) : null;
    if (!resolved) return null;
    spillTypes.set(name, resolved);
  }

  return { states, spills, spillTypes, elemValType, delegationSites };
}

/** A `break`/`continue` inside a yield-loop body is not modeled in this slice. */
function loopBodyHasUnsupportedJump(body: ts.Statement): boolean {
  let bad = false;
  function visit(node: ts.Node): void {
    if (bad) return;
    if (ts.isBreakStatement(node) || ts.isContinueStatement(node)) {
      bad = true;
      return;
    }
    // Don't descend into nested loops/switches — their break/continue bind
    // there, not to the loop we're checking. (A break in a nested yield-free
    // loop is fine; a break in THIS loop that crosses a yield is the problem.
    // Conservatively reject any break/continue at this level when the body
    // yields — caller only invokes this for yielding bodies.)
    if (
      ts.isForStatement(node) ||
      ts.isForInStatement(node) ||
      ts.isForOfStatement(node) ||
      ts.isWhileStatement(node) ||
      ts.isDoStatement(node) ||
      ts.isSwitchStatement(node) ||
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node)
    ) {
      return;
    }
    ts.forEachChild(node, visit);
  }
  ts.forEachChild(body, visit);
  return bad;
}

function thenBody(stmt: ts.Statement): readonly ts.Statement[] {
  if (ts.isBlock(stmt)) return stmt.statements;
  return [stmt];
}

/**
 * (#2571) True when a method body references `super.*` (a `SuperKeyword` that is
 * not just a nested function's own `super`). The native generator resume
 * function has no `super`-binding setup, so a `super`-using method generator
 * bails to the eager-buffer host path. Stops at nested non-arrow functions
 * (their `super` is their own concern); arrow functions inherit the method's
 * `super`, so it does NOT stop at them.
 */
function methodBodyUsesSuper(body: ts.Node): boolean {
  let found = false;
  function visit(node: ts.Node): void {
    if (found) return;
    if (node.kind === ts.SyntaxKind.SuperKeyword) {
      found = true;
      return;
    }
    // Nested non-arrow function-likes rebind `super` — their `super` is their
    // own; do not descend (arrow functions keep the enclosing `super`).
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isConstructorDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node)
    ) {
      return;
    }
    ts.forEachChild(node, visit);
  }
  ts.forEachChild(body, visit);
  return found;
}

/**
 * (#2571) A native-generator candidate is either a named `function*`
 * declaration or a class / object-literal generator METHOD. Both expose
 * `.body` / `.parameters` / `.asteriskToken` / `.name`, so the plan builder and
 * the state model treat them uniformly; the only method-specific handling is the
 * synthetic `this` leading param (threaded in `registerNativeGenerator`).
 */
export type GeneratorDecl = ts.FunctionDeclaration | ts.MethodDeclaration;

export function isNativeGeneratorCandidate(ctx: CodegenContext, decl: GeneratorDecl): boolean {
  if (!noJsHostTarget(ctx)) return false;
  if (!decl.name || !decl.body || !decl.asteriskToken) return false;
  // (#2571) An object-literal method with a computed/string name
  // (`{ [k]*(){} }`, `{ "m"*(){} }`) is out of scope — only an identifier-named
  // method threads cleanly through the funcMap key. A FunctionDeclaration name
  // is always an Identifier.
  if (ts.isMethodDeclaration(decl) && !ts.isIdentifier(decl.name)) return false;
  // (#2571/#2581) A method generator is native-routable only when its emit site
  // is wired to the native factory: CLASS bodies (class-bodies.ts, #2571) and
  // OBJECT-LITERAL methods (literals.ts, #2581). Both compile the method body as
  // a func whose param 0 is the receiver `this` (a `ref $struct`), so the
  // synthetic-`this` state-struct model applies uniformly. Any OTHER
  // MethodDeclaration context (e.g. a TS interface/type member, or a shape the
  // emit paths don't cover) keeps the host path — bailing here (the single
  // candidate gate consumed by both `registerNativeGenerator` AND
  // `sourceNeedsGeneratorHostImports`) keeps the host imports registered,
  // avoiding an undefined-funcidx invalid module.
  if (ts.isMethodDeclaration(decl) && !ts.isClassLike(decl.parent) && !ts.isObjectLiteralExpression(decl.parent)) {
    return false;
  }
  const modifiers = ts.canHaveModifiers(decl) ? ts.getModifiers(decl) : undefined;
  if (modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword || m.kind === ts.SyntaxKind.DeclareKeyword)) {
    return false;
  }
  for (const param of decl.parameters) {
    if (param.dotDotDotToken || !ts.isIdentifier(param.name)) return false;
  }
  // (#2581) An OBJECT-LITERAL generator method with a DEFAULT or OPTIONAL param
  // must bail to the host path. Object-literal methods are invoked through the
  // closure trampoline (`emitObjectMethodAsClosure`), which forwards args but
  // does NOT set the `__argc_default` global the param-default check reads — so
  // the native factory would read the un-defaulted sentinel and yield the wrong
  // value (`{ *m(d=5){yield d} }.m()` → 0 instead of 5). Class methods are called
  // directly (argc set), so they keep defaults native. The eager-buffer host path
  // applies defaults correctly for the object-literal case, so route there.
  if (ts.isMethodDeclaration(decl) && ts.isObjectLiteralExpression(decl.parent)) {
    for (const param of decl.parameters) {
      if (param.initializer || param.questionToken) return false;
    }
  }
  // (#2571) A method generator that reads `arguments`, uses `super.*`, or
  // CAPTURES an enclosing-function binding (#2203) has no native state-machine
  // support: the eager-buffer path builds the arguments vec / closure, while the
  // native state struct has slots only for `this` + own params, not captures.
  // Bail to the host path so it stays correct (host) / refuses cleanly
  // (standalone) rather than reading a garbage slot. This keeps the candidate
  // gate the SINGLE source of truth — `registerNativeGenerator` (class-bodies)
  // and `sourceNeedsGeneratorHostImports` both consult it and agree.
  if (
    ts.isMethodDeclaration(decl) &&
    decl.body &&
    (bodyUsesArguments(decl.body) || methodBodyUsesSuper(decl.body) || generatorCapturesOuterScope(ctx, decl))
  ) {
    return false;
  }
  const plan = buildNativeGeneratorPlan(ctx, decl);
  return plan !== null && plan.states.some((s) => s.terminator.kind === "yield" || s.terminator.kind === "yield-star");
}

/**
 * (#2203) True when `decl` is a generator nested inside another function that
 * reads or writes a binding from an enclosing scope (a "capture"). Such a
 * generator cannot use the Wasm-native generator factory — its state lives in a
 * struct, with no slot for captured outer-scope bindings, so the native
 * registration in `nested-declarations.ts` is gated on `captures.length === 0`
 * and a capturing generator falls through to the eager-buffer host path. In a
 * no-JS-host target the eager path needs the `__gen_*` host imports; if they
 * were never registered (because `isNativeGeneratorCandidate` — which does not
 * model captures — wrongly classified this as native), the emit bakes a
 * `funcIdx: undefined` and produces invalid Wasm. Flagging the capture here lets
 * `sourceNeedsGeneratorHostImports` register the host imports so the funcidx is
 * valid (the test262 standalone runner supplies the `__gen_*` shim). A
 * non-capturing nested generator stays native and is NOT flagged, so it does not
 * gain unused host-import dependencies.
 */
function generatorCapturesOuterScope(ctx: CodegenContext, decl: GeneratorDecl): boolean {
  if (!decl.body) return false;
  // Only generators nested inside another function-like scope can capture; a
  // top-level generator's free variables are module globals, which the native
  // lowering already reads/writes directly (no host buffer needed).
  let ancestor: ts.Node | undefined = decl.parent;
  let nested = false;
  while (ancestor) {
    if (ts.isSourceFile(ancestor)) break;
    if (
      ts.isFunctionDeclaration(ancestor) ||
      ts.isFunctionExpression(ancestor) ||
      ts.isArrowFunction(ancestor) ||
      ts.isMethodDeclaration(ancestor) ||
      ts.isConstructorDeclaration(ancestor) ||
      ts.isGetAccessorDeclaration(ancestor) ||
      ts.isSetAccessorDeclaration(ancestor)
    ) {
      nested = true;
      break;
    }
    ancestor = ancestor.parent;
  }
  if (!nested) return false;

  let captures = false;
  const checker = ctx.checker;
  function scan(node: ts.Node): void {
    if (captures) return;
    if (ts.isIdentifier(node) && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)) {
      const sym = checker.getSymbolAtLocation(node);
      const declNode = sym?.declarations?.[0];
      if (declNode) {
        // A binding declared OUTSIDE the generator body, yet inside some
        // enclosing function (i.e. not a module global / global builtin), is a
        // capture. Walk the declaration's ancestors: if we reach the generator
        // decl it is local (not a capture); if we reach an enclosing function
        // first it is captured; if we reach the SourceFile it is a module/global
        // binding the native path handles directly.
        let p: ts.Node | undefined = declNode;
        while (p) {
          if (p === decl) return; // declared within the generator → local
          if (p === decl.body) return;
          if (
            ts.isFunctionDeclaration(p) ||
            ts.isFunctionExpression(p) ||
            ts.isArrowFunction(p) ||
            ts.isMethodDeclaration(p) ||
            ts.isConstructorDeclaration(p)
          ) {
            // Reached an enclosing function before the SourceFile → captured.
            captures = true;
            return;
          }
          if (ts.isSourceFile(p)) return; // module-level binding → not a capture
          p = p.parent;
        }
      }
    }
    ts.forEachChild(node, scan);
  }
  scan(decl.body);
  return captures;
}

export function sourceNeedsGeneratorHostImports(ctx: CodegenContext, sourceFile: ts.SourceFile): boolean {
  let found = false;
  let needsHost = false;

  function visit(node: ts.Node): void {
    if (needsHost) return;
    if (ts.isFunctionDeclaration(node) && node.asteriskToken && node.body) {
      found = true;
      // A non-native-candidate generator needs the host imports; so does a
      // nested generator that captures an outer-scope binding (#2203) — it
      // cannot use the native factory (no capture slot in the state struct) and
      // falls to the eager-buffer host path, which would otherwise bake an
      // undefined funcidx in a no-JS-host target.
      if (!isNativeGeneratorCandidate(ctx, node) || generatorCapturesOuterScope(ctx, node)) needsHost = true;
      return;
    }
    if (ts.isFunctionExpression(node) && node.asteriskToken) {
      found = true;
      needsHost = true;
      return;
    }
    if (ts.isMethodDeclaration(node) && node.asteriskToken && node.body) {
      found = true;
      // (#2571) A class / object-literal generator METHOD that the native path
      // can lower (instance/static, identifier params, no capture / arguments /
      // super) no longer forces the host imports — same logic as the
      // FunctionDeclaration branch above, generalized to methods. A
      // non-candidate or capturing method generator still needs the host buffer.
      if (!isNativeGeneratorCandidate(ctx, node) || generatorCapturesOuterScope(ctx, node)) needsHost = true;
      return;
    }
    ts.forEachChild(node, visit);
  }

  ts.forEachChild(sourceFile, visit);
  return found && needsHost;
}

/**
 * Result struct (`{ value, done }`) for a generator whose yields have the given
 * `elemValType`. The numeric (f64) variant is cached on
 * `ctx.nativeGeneratorResultTypeIdx` (the historical singleton, kept so the many
 * f64 callers are unchanged); any other elem type (e.g. the native string ref,
 * #2171) gets its own `__NativeGeneratorResult_<kind>` struct, cached in
 * `structMap` by name. Defaults to f64 when no elem type is supplied.
 */
export function ensureNativeGeneratorResultType(ctx: CodegenContext, elemValType?: ValType): number {
  const elem: ValType = elemValType ?? { kind: "f64" };
  const isF64 = elem.kind === "f64";
  if (isF64 && ctx.nativeGeneratorResultTypeIdx >= 0) return ctx.nativeGeneratorResultTypeIdx;

  const kindTag =
    elem.kind === "ref" || elem.kind === "ref_null" ? `ref${(elem as { typeIdx: number }).typeIdx}` : elem.kind;
  const structName = `__NativeGeneratorResult_${kindTag}`;
  const existing = ctx.structMap.get(structName);
  if (existing !== undefined) {
    if (isF64) ctx.nativeGeneratorResultTypeIdx = existing;
    return existing;
  }

  const fields: FieldDef[] = [
    { name: "value", type: elem, mutable: false },
    { name: "done", type: { kind: "i32" }, mutable: false },
  ];
  const typeIdx = ctx.mod.types.length;
  ctx.mod.types.push({ kind: "struct", name: structName, fields });
  ctx.structMap.set(structName, typeIdx);
  ctx.typeIdxToStructName.set(typeIdx, structName);
  ctx.structFields.set(structName, fields);
  if (isF64) ctx.nativeGeneratorResultTypeIdx = typeIdx;
  return typeIdx;
}

export function registerNativeGenerator(
  ctx: CodegenContext,
  decl: GeneratorDecl,
  functionName: string,
  paramTypes: ValType[],
  // (#2571) When `decl` is a non-static instance generator METHOD, the caller
  // passes `paramTypes = [receiverType, ...userParamTypes]` and sets this flag.
  // We then prepend a `"this"` entry to `paramNames` so the state struct mints a
  // `param_this` field (rehydrated as a `this` local in the resume function) and
  // the param/name arrays stay aligned. Free functions / static methods leave
  // this `false` — byte-identical to pre-#2571.
  synthesizedThis = false,
): NativeGeneratorInfo | null {
  const existing = ctx.nativeGenerators.get(functionName);
  if (existing) return existing;
  if (!isNativeGeneratorCandidate(ctx, decl)) return null;

  const plan = buildNativeGeneratorPlan(ctx, decl);
  if (!plan) return null;

  const elemValType = plan.elemValType;
  // (#2864 F1b) Spilled locals are now typed at their actual ValType
  // (`plan.spillTypes`), so the historical string/any guards that bailed any
  // generator with a live-across-yield non-numeric local are retired — the plan
  // builder already returned null for any spill whose type it could not resolve.

  const resultTypeIdx = ensureNativeGeneratorResultType(ctx, elemValType);
  // (#2571) The synthetic `this` (when present) is the FIRST param name, aligned
  // with the caller's `paramTypes[0] === receiverType`. User params follow.
  const userParamNames = decl.parameters.map((p) => (ts.isIdentifier(p.name) ? p.name.text : ""));
  const paramNames = synthesizedThis ? ["this", ...userParamNames] : userParamNames;
  // (#2864 F1) `sent` / `abrupt` carry the `.next(v)` / `.return(v)` value. For
  // the boxed-any carrier they are externref so an arbitrary value survives; for
  // numeric / string carriers they stay f64 (byte-identical to before).
  const carrierFieldType = genCarrierFieldType(elemValType);
  const stateFields: FieldDef[] = [
    { name: "state", type: { kind: "i32" }, mutable: true },
    { name: "sent", type: carrierFieldType, mutable: true },
    { name: "mode", type: { kind: "i32" }, mutable: true },
    { name: "abrupt", type: carrierFieldType, mutable: true },
    // (#2864 F2) `gen.throw(e)` payload — externref regardless of carrier.
    { name: "error", type: { kind: "externref" }, mutable: true },
  ];
  for (let i = 0; i < paramTypes.length; i++) {
    stateFields.push({
      name: `param_${paramNames[i] ?? i}`,
      type: paramTypes[i]!,
      mutable: false,
    });
  }
  const spillFieldOffset = PARAM_FIELD_OFFSET + paramTypes.length;
  // Params that are also reassigned in the body need a mutable spill slot too;
  // but params already live in the struct. Spills cover body-declared locals.
  const paramNameSet = new Set(paramNames);
  const bodySpills = plan.spills.filter((s) => !paramNameSet.has(s));
  // (#2864 F1b) Spill field at the local's actual ValType (object → ref_null
  // struct, string → native-string ref, number → f64), aligned 1:1 with
  // `bodySpills` so the resume-load local, store/load, and struct-init default
  // all agree. `plan.spillTypes` is guaranteed to hold an entry for each spill.
  const spillTypes: ValType[] = bodySpills.map((s) => plan.spillTypes.get(s) ?? { kind: "f64" });
  for (let i = 0; i < bodySpills.length; i++) {
    stateFields.push({
      name: `spill_${bodySpills[i]}`,
      type: spillTypes[i]!,
      mutable: true,
    });
  }

  // (#2170) `yield*` delegation slots — appended AFTER spills so the f64
  // spillFieldOffset indexing is unaffected. Each holds the inner generator's
  // state ref across the outer generator's host re-entries. The inner is a
  // native generator (the candidate check confirmed it); register it first so
  // its state struct typeIdx exists, then type the slot as `ref null
  // $InnerState`.
  const delegationSlots: { fieldIdx: number; innerName: string }[] = [];
  for (const site of plan.delegationSites) {
    const innerInfo = ensureRegisteredNativeGenerator(ctx, site.innerName);
    // Fall back to a nullable eqref slot if the inner cannot be resolved to a
    // concrete state type (defensive — the candidate gate makes this unlikely).
    const slotType: ValType =
      innerInfo !== null ? { kind: "ref_null", typeIdx: innerInfo.stateTypeIdx } : { kind: "eqref" };
    delegationSlots.push({ fieldIdx: stateFields.length, innerName: site.innerName });
    stateFields.push({ name: `deleg_${delegationSlots.length - 1}`, type: slotType, mutable: true });
  }

  const stateName = `__GenState_${sanitizeTypeName(functionName)}`;
  const stateTypeIdx = ctx.mod.types.length;
  ctx.mod.types.push({ kind: "struct", name: stateName, fields: stateFields });
  ctx.structMap.set(stateName, stateTypeIdx);
  ctx.typeIdxToStructName.set(stateTypeIdx, stateName);
  ctx.structFields.set(stateName, stateFields);

  const yieldCount = plan.states.filter((s) => s.terminator.kind === "yield").length;
  const info: NativeGeneratorInfo = {
    functionName,
    decl,
    synthesizedThis,
    stateTypeIdx,
    resultTypeIdx,
    paramNames,
    paramTypes,
    paramFieldOffset: PARAM_FIELD_OFFSET,
    sentFieldIdx: SENT_FIELD,
    modeFieldIdx: MODE_FIELD,
    abruptFieldIdx: ABRUPT_FIELD,
    spillNames: bodySpills,
    spillTypes,
    spillFieldOffset,
    yieldCount,
    doneState: plan.states.length - 1, // the final `done` state id
    elemValType,
    delegationSlots: delegationSlots.length > 0 ? delegationSlots : undefined,
  };
  ctx.nativeGenerators.set(functionName, info);
  return info;
}

/**
 * (#2170) Resolve a native-generator info by source name (already-registered
 * lookup). The inner of a `yield*` is usually declared before the outer (source
 * order) and already in `ctx.nativeGenerators`. Returns null if not registered.
 */
function ensureRegisteredNativeGenerator(ctx: CodegenContext, name: string): NativeGeneratorInfo | null {
  const existing = ctx.nativeGenerators.get(name);
  if (existing) return existing;
  return null;
}

// (#2171) The default `value` for a done/empty result: f64 0 for numeric
// generators, a null ref for string (the consumer never reads value when
// done=1, so the null is inert — it only satisfies struct.new's type).
function defaultElemValueInstr(elemValType: ValType): Instr {
  if (elemValType.kind === "f64") return { op: "f64.const", value: 0 };
  if (elemValType.kind === "i32") return { op: "i32.const", value: 0 };
  // (#2864 F1) The boxed-any carrier's inert default is a null externref.
  if (elemValType.kind === "externref") return { op: "ref.null.extern" } as Instr;
  return { op: "ref.null", typeIdx: (elemValType as { typeIdx: number }).typeIdx } as Instr;
}

function emptyResult(info: NativeGeneratorInfo): Instr[] {
  return [
    defaultElemValueInstr(info.elemValType),
    { op: "i32.const", value: 1 },
    { op: "struct.new", typeIdx: info.resultTypeIdx },
  ];
}

// (#2864 F1b) The inert default a spill field is constructed with, by ValType.
// Overwritten by the body's declaration on first entry into the owning state, so
// it only has to satisfy `struct.new`'s field type. Mirrors `defaultElemValueInstr`
// but spans the full set of supported spill kinds.
function defaultSpillInstr(type: ValType): Instr {
  switch (type.kind) {
    case "f64":
      return { op: "f64.const", value: NaN };
    case "i32":
      return { op: "i32.const", value: 0 };
    case "i64":
      return { op: "i64.const", value: 0n } as Instr;
    case "externref":
      return { op: "ref.null.extern" } as Instr;
    default:
      return { op: "ref.null", typeIdx: (type as { typeIdx: number }).typeIdx } as Instr;
  }
}

function emptyResultForType(resultTypeIdx: number): Instr[] {
  return [
    { op: "f64.const", value: 0 },
    { op: "i32.const", value: 1 },
    { op: "struct.new", typeIdx: resultTypeIdx },
  ];
}

function setStateInstrs(info: NativeGeneratorInfo, selfLocal: number, state: number): Instr[] {
  return [
    { op: "local.get", index: selfLocal },
    { op: "i32.const", value: state },
    { op: "struct.set", typeIdx: info.stateTypeIdx, fieldIdx: STATE_FIELD },
  ];
}

function setModeInstrs(info: NativeGeneratorInfo, selfLocal: number, mode: number): Instr[] {
  return [
    { op: "local.get", index: selfLocal },
    { op: "i32.const", value: mode },
    { op: "struct.set", typeIdx: info.stateTypeIdx, fieldIdx: info.modeFieldIdx },
  ];
}

function setStateFieldFromLocal(
  info: NativeGeneratorInfo,
  selfLocal: number,
  fieldIdx: number,
  valueLocal: number,
): Instr[] {
  return [
    { op: "local.get", index: selfLocal },
    { op: "local.get", index: valueLocal },
    { op: "struct.set", typeIdx: info.stateTypeIdx, fieldIdx },
  ];
}

function setStateI32FromConst(info: NativeGeneratorInfo, selfLocal: number, fieldIdx: number, value: number): Instr[] {
  return [
    { op: "local.get", index: selfLocal },
    { op: "i32.const", value },
    { op: "struct.set", typeIdx: info.stateTypeIdx, fieldIdx },
  ];
}

function nativeReturnResultFromLocal(info: NativeGeneratorInfo, valueLocal: number): Instr[] {
  return [
    { op: "local.get", index: valueLocal },
    { op: "i32.const", value: 1 },
    { op: "struct.new", typeIdx: info.resultTypeIdx },
  ];
}

function storeSpills(info: NativeGeneratorInfo, fctx: FunctionContext, selfLocal: number): Instr[] {
  const body: Instr[] = [];
  for (let i = 0; i < info.spillNames.length; i++) {
    const localIdx = fctx.localMap.get(info.spillNames[i]!);
    if (localIdx === undefined) continue;
    body.push({ op: "local.get", index: selfLocal });
    body.push({ op: "local.get", index: localIdx });
    body.push({ op: "struct.set", typeIdx: info.stateTypeIdx, fieldIdx: info.spillFieldOffset + i });
  }
  return body;
}

function emitExpressionAsF64(ctx: CodegenContext, fctx: FunctionContext, expr: ts.Expression | undefined): number {
  if (!expr) {
    const tmp = allocLocal(fctx, `__gen_value_${fctx.locals.length}`, { kind: "f64" });
    fctx.body.push({ op: "f64.const", value: NaN });
    fctx.body.push({ op: "local.set", index: tmp });
    return tmp;
  }

  const resultType = compileExpression(ctx, fctx, expr, { kind: "f64" });
  if (resultType === null) {
    fctx.body.push({ op: "f64.const", value: NaN });
  } else if (resultType.kind === "i32") {
    fctx.body.push({ op: "f64.convert_i32_s" });
  } else if (!valTypesMatch(resultType, { kind: "f64" })) {
    coerceType(ctx, fctx, resultType, { kind: "f64" });
  }
  const tmp = allocLocal(fctx, `__gen_value_${fctx.locals.length}`, { kind: "f64" });
  fctx.body.push({ op: "local.set", index: tmp });
  return tmp;
}

/**
 * (#2864 F1) Compile a `.next(v)` / `.return(v)` argument to the generator's
 * carrier field type and return a local holding it. For numeric / string
 * carriers this is exactly `emitExpressionAsF64` (the f64 `sent`/`abrupt` field,
 * byte-identical to before). For the boxed-any carrier the value is compiled to
 * externref (host-free boxing in standalone/WASI), so an arbitrary `.next(v)`
 * survives into the resume function. A missing arg yields the carrier default
 * (`NaN` for f64, null externref for the boxed-any carrier).
 */
function emitCarrierValue(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.Expression | undefined,
  info: NativeGeneratorInfo,
): number {
  if (!carrierIsAny(info.elemValType)) return emitExpressionAsF64(ctx, fctx, expr);
  const carrier: ValType = { kind: "externref" };
  const tmp = allocLocal(fctx, `__gen_carrier_${fctx.locals.length}`, carrier);
  if (!expr) {
    fctx.body.push({ op: "ref.null.extern" } as Instr);
    fctx.body.push({ op: "local.set", index: tmp });
    return tmp;
  }
  const t = compileExpression(ctx, fctx, expr, carrier);
  if (t === null) {
    fctx.body.push({ op: "ref.null.extern" } as Instr);
  } else if (!valTypesMatch(t, carrier)) {
    coerceType(ctx, fctx, t, carrier);
  }
  fctx.body.push({ op: "local.set", index: tmp });
  return tmp;
}

/**
 * (#2864 F1) Compile a `.next(v)` / `.return(v)` argument to externref (the
 * boxed-`any` representation) for the open dispatch, returning a local holding
 * it. A missing argument is a null externref. Used only when the dispatch chain
 * includes an any-carrier generator.
 */
function emitOpenAnyArgValue(ctx: CodegenContext, fctx: FunctionContext, expr: ts.Expression | undefined): number {
  const carrier: ValType = { kind: "externref" };
  const tmp = allocLocal(fctx, `__gen_any_arg_${fctx.locals.length}`, carrier);
  if (!expr) {
    fctx.body.push({ op: "ref.null.extern" } as Instr);
    fctx.body.push({ op: "local.set", index: tmp });
    return tmp;
  }
  const t = compileExpression(ctx, fctx, expr, carrier);
  if (t === null) {
    fctx.body.push({ op: "ref.null.extern" } as Instr);
  } else if (!valTypesMatch(t, carrier)) {
    coerceType(ctx, fctx, t, carrier);
  }
  fctx.body.push({ op: "local.set", index: tmp });
  return tmp;
}

/**
 * (#2171) Compile a yield/return value to the generator's element ValType and
 * return a local holding it. For numeric generators this is exactly
 * `emitExpressionAsF64` (unchanged path). For a string generator it compiles the
 * expression to the native string ref and stores it; a missing expr (bare
 * `return;`) yields the elem-type default (null ref).
 */
function emitYieldValueAsElem(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.Expression | undefined,
  info: NativeGeneratorInfo,
): number {
  if (info.elemValType.kind === "f64") return emitExpressionAsF64(ctx, fctx, expr);
  const elem = info.elemValType;
  const tmp = allocLocal(fctx, `__gen_value_${fctx.locals.length}`, elem);
  if (!expr) {
    fctx.body.push(defaultElemValueInstr(elem));
    fctx.body.push({ op: "local.set", index: tmp });
    return tmp;
  }
  const t = compileExpression(ctx, fctx, expr, elem);
  if (t === null) {
    fctx.body.push(defaultElemValueInstr(elem));
  } else if (!valTypesMatch(t, elem)) {
    coerceType(ctx, fctx, t, elem);
  }
  fctx.body.push({ op: "local.set", index: tmp });
  return tmp;
}

/**
 * Compile a numeric condition to an i32 truthiness on the stack. Booleans are
 * already i32; numbers compile to f64, so reduce with `f64.ne 0` (NaN → 0,
 * matching JS ToBoolean for numbers).
 */
function emitConditionAsI32(ctx: CodegenContext, fctx: FunctionContext, expr: ts.Expression): void {
  const t = compileExpression(ctx, fctx, expr);
  if (t === null) {
    fctx.body.push({ op: "i32.const", value: 0 });
    return;
  }
  if (t.kind === "i32") return;
  if (t.kind === "f64") {
    fctx.body.push({ op: "f64.const", value: 0 });
    fctx.body.push({ op: "f64.ne" });
    return;
  }
  // Fallback: coerce to f64 then truthiness.
  coerceType(ctx, fctx, t, { kind: "f64" });
  fctx.body.push({ op: "f64.const", value: 0 });
  fctx.body.push({ op: "f64.ne" });
}

/**
 * Emit the trampoline resume body into `fctx.body`. `selfLocal` is the state
 * struct ref. The shape is:
 *
 *   block $exit (result <empty, $__result holds the value>)
 *     loop $dispatch
 *       if (state==0) { …state 0… }
 *       else if (state==1) { …state 1… }
 *       …
 *       else { done }
 *     end
 *   end
 *   local.get $__result
 *
 * Each state's terminator emits:
 *   - yield/return  → set $__result, `br $exit`
 *   - jump/branch   → set state, `br $dispatch`
 *   - done          → set $__result (=undefined,done:1); fall out of loop
 */
function emitTrampoline(
  ctx: CodegenContext,
  fctx: FunctionContext,
  info: NativeGeneratorInfo,
  plan: NativeGeneratorPlan,
  selfLocal: number,
  resultLocal: number,
): Instr[] {
  const states = plan.states;

  // Recursively build the nested-if chain. `level` is the recursion depth
  // (0-based) — used to compute branch depths: from inside the arm at `level`,
  // the enclosing `loop` is at depth `level+1` and the wrapping `block` at
  // `level+2`.
  function buildArm(stateId: number, level: number): Instr[] {
    if (stateId >= states.length) {
      // Past the last state: complete (defensive; should be the `done` state).
      return [
        ...setStateInstrs(info, selfLocal, info.doneState),
        ...emptyResult(info),
        { op: "local.set", index: resultLocal },
      ];
    }
    const loopDepth = level + 1; // br to re-enter dispatch
    const exitDepth = level + 2; // br to leave block (return to caller)

    const thenBody = compileState(
      ctx,
      fctx,
      info,
      states[stateId]!,
      stateId,
      loopDepth,
      exitDepth,
      selfLocal,
      resultLocal,
    );
    const elseBody = buildArm(stateId + 1, level + 1);
    return [
      { op: "local.get", index: selfLocal },
      { op: "struct.get", typeIdx: info.stateTypeIdx, fieldIdx: STATE_FIELD },
      { op: "i32.const", value: stateId },
      { op: "i32.eq" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: thenBody,
        else: elseBody,
      },
    ];
  }

  const chain = buildArm(0, 0);

  return [
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: chain,
        } as Instr,
      ],
    } as Instr,
    { op: "local.get", index: resultLocal },
  ];
}

/**
 * Compile one state's prelude + terminator into an Instr[] for its dispatch
 * arm. Branch depths are passed in (the arm sits `level` ifs deep inside the
 * trampoline loop).
 */
function compileState(
  ctx: CodegenContext,
  fctx: FunctionContext,
  info: NativeGeneratorInfo,
  state: NativeGeneratorState,
  stateId: number,
  loopDepth: number,
  exitDepth: number,
  selfLocal: number,
  resultLocal: number,
): Instr[] {
  const saved = fctx.body;
  const body: Instr[] = [];
  fctx.body = body;
  // (#2182) `saved` is detached for the whole resume-state build, which runs
  // `compileStatement` / `emitYieldValueAsElem` — both can trigger a late
  // import. The shifter walks `fctx.body` (= body) but not this raw local, so
  // register `saved` in liveBodies for the swap's lifetime; otherwise a late
  // import would over-shift any `call` funcIdx already in the outer body.
  ctx.liveBodies.add(saved);

  // Abrupt-resume handling: if we resumed into this state in an abrupt mode
  // (mode != 0), run the enclosing finalizers, then either complete with the
  // `.return(v)` value (mode 1) or RE-THROW the `.throw(e)` error (mode 2, #2864
  // F2). Both share the finalizer run + spill store + done transition; they
  // diverge only at the tail. The finalizers are compiled ONCE into `abruptBody`,
  // which the outer `if (mode != 0)` guards.
  if (state.abruptResume) {
    const abruptBody: Instr[] = [];
    const savedAbrupt = fctx.body;
    fctx.body = abruptBody;
    for (const finalizer of state.abruptResume.finalizers) {
      for (const stmt of finalizer) compileStatement(ctx, fctx, stmt);
    }
    abruptBody.push(...storeSpills(info, fctx, selfLocal));
    abruptBody.push(...setStateInstrs(info, selfLocal, info.doneState));

    // mode 2 (throw): re-throw the stored error. `throw` is stack-polymorphic
    // (control leaves the resume function), so no value/`br` is needed and the
    // generator surfaces the error to the `.throw(e)` caller, finalizers having
    // run first (§27.5.3.4 GeneratorResumeAbrupt with a throw completion, no
    // catch in this slice — try/catch-across-yield stays the next slice).
    const throwBody: Instr[] = [
      { op: "local.get", index: selfLocal },
      { op: "struct.get", typeIdx: info.stateTypeIdx, fieldIdx: ERROR_FIELD },
      { op: "throw", tagIdx: ensureExnTag(ctx) } as Instr,
    ];

    // mode 1 (return): complete with the abrupt value (unchanged from F1). The
    // `.return(v)` value lives in `abrupt` when its carrier matches the result
    // `value` type (numeric / boxed-any); for a string generator the abrupt
    // field stays f64, so complete with the elem default (string `.return(v)` is
    // a documented follow-up). br depth is exitDepth + 2 — inside the outer
    // `if (mode != 0)` AND the inner `if (mode == 2) … else …`.
    const returnBody: Instr[] = [];
    if (valTypesMatch(genCarrierFieldType(info.elemValType), info.elemValType)) {
      returnBody.push({ op: "local.get", index: selfLocal });
      returnBody.push({ op: "struct.get", typeIdx: info.stateTypeIdx, fieldIdx: info.abruptFieldIdx });
    } else {
      returnBody.push(defaultElemValueInstr(info.elemValType));
    }
    returnBody.push({ op: "i32.const", value: 1 });
    returnBody.push({ op: "struct.new", typeIdx: info.resultTypeIdx });
    returnBody.push({ op: "local.set", index: resultLocal });
    returnBody.push({ op: "br", depth: exitDepth + 2 });

    abruptBody.push({ op: "local.get", index: selfLocal });
    abruptBody.push({ op: "struct.get", typeIdx: info.stateTypeIdx, fieldIdx: info.modeFieldIdx });
    abruptBody.push({ op: "i32.const", value: MODE_THROW });
    abruptBody.push({ op: "i32.eq" });
    abruptBody.push({ op: "if", blockType: { kind: "empty" }, then: throwBody, else: returnBody });
    fctx.body = savedAbrupt;

    body.push({ op: "local.get", index: selfLocal });
    body.push({ op: "struct.get", typeIdx: info.stateTypeIdx, fieldIdx: info.modeFieldIdx });
    body.push({ op: "i32.const", value: MODE_NEXT });
    body.push({ op: "i32.ne" });
    body.push({ op: "if", blockType: { kind: "empty" }, then: abruptBody, else: [] });
  }

  // Resume bindings: copy the `.next(value)` sent value into the bound local
  // and its spill field.
  for (const name of state.resumeBindings) {
    const localIdx = fctx.localMap.get(name);
    const spillIdx = info.spillNames.indexOf(name);
    if (localIdx === undefined || spillIdx < 0) continue;
    body.push({ op: "local.get", index: selfLocal });
    body.push({ op: "struct.get", typeIdx: info.stateTypeIdx, fieldIdx: info.sentFieldIdx });
    body.push({ op: "local.set", index: localIdx });
    body.push({ op: "local.get", index: selfLocal });
    body.push({ op: "local.get", index: localIdx });
    body.push({ op: "struct.set", typeIdx: info.stateTypeIdx, fieldIdx: info.spillFieldOffset + spillIdx });
  }

  // Prelude statements (straight-line, yield-free).
  for (const stmt of state.statements) compileStatement(ctx, fctx, stmt);

  const term = state.terminator;
  switch (term.kind) {
    case "yield": {
      const tmp = emitYieldValueAsElem(ctx, fctx, term.expr, info);
      body.push(...storeSpills(info, fctx, selfLocal));
      body.push(...setStateInstrs(info, selfLocal, term.next));
      body.push(...setModeInstrs(info, selfLocal, 0));
      body.push({ op: "local.get", index: tmp });
      body.push({ op: "i32.const", value: 0 });
      body.push({ op: "struct.new", typeIdx: info.resultTypeIdx });
      body.push({ op: "local.set", index: resultLocal });
      body.push({ op: "br", depth: exitDepth }); // leave trampoline → return result
      break;
    }
    case "return": {
      const tmp = emitYieldValueAsElem(ctx, fctx, term.expr, info);
      body.push(...storeSpills(info, fctx, selfLocal));
      body.push(...setStateInstrs(info, selfLocal, info.doneState));
      body.push(...setModeInstrs(info, selfLocal, 0));
      body.push({ op: "local.get", index: tmp });
      body.push({ op: "i32.const", value: 1 });
      body.push({ op: "struct.new", typeIdx: info.resultTypeIdx });
      body.push({ op: "local.set", index: resultLocal });
      body.push({ op: "br", depth: exitDepth });
      break;
    }
    case "jump": {
      body.push(...storeSpills(info, fctx, selfLocal));
      body.push(...setStateInstrs(info, selfLocal, term.next));
      body.push({ op: "br", depth: loopDepth }); // re-enter dispatch at new state
      break;
    }
    case "branch": {
      body.push(...storeSpills(info, fctx, selfLocal));
      emitConditionAsI32(ctx, fctx, term.cond);
      if (term.negate) body.push({ op: "i32.eqz" });
      body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: [
          ...setStateInstrs(info, selfLocal, term.thenState),
          { op: "br", depth: loopDepth + 1 }, // +1 for the inner branch `if`
        ],
        else: [...setStateInstrs(info, selfLocal, term.elseState), { op: "br", depth: loopDepth + 1 }],
      });
      break;
    }
    case "done": {
      body.push(...storeSpills(info, fctx, selfLocal));
      body.push(...setStateInstrs(info, selfLocal, info.doneState));
      body.push(...emptyResult(info));
      body.push({ op: "local.set", index: resultLocal });
      // No br: fall out of the trampoline loop (loop only repeats on explicit
      // br), then `block $exit` ends and the caller reads $__result.
      break;
    }
    case "yield-star": {
      // (#2170) Delegate to the inner native generator. §27.5.3.7:
      //   if (deleg == null) deleg = <inner>();           ; first entry
      //   innerRes = __gen_resume_<inner>(deleg);
      //   if (innerRes.done == 0) {                        ; inner yielded
      //     store spills; state = THIS; mode = 0;
      //     result = { innerRes.value, done: 0 }; br exit; ; re-enter here next .next()
      //   } else {                                         ; inner done
      //     deleg = null; state = next; br loop;           ; resume outer machine
      //   }
      const slot = info.delegationSlots?.[term.siteIndex];
      const innerInfo = slot ? ctx.nativeGenerators.get(slot.innerName) : undefined;
      if (!slot || !innerInfo) {
        // Defensive: the plan recorded a delegation site the struct/registry
        // did not back. Complete the generator rather than emit invalid wasm.
        body.push(...storeSpills(info, fctx, selfLocal));
        body.push(...setStateInstrs(info, selfLocal, info.doneState));
        body.push(...emptyResult(info));
        body.push({ op: "local.set", index: resultLocal });
        break;
      }
      const innerResumeIdx = ensureNativeGeneratorResumeFunction(ctx, innerInfo);
      const innerStateRef: ValType = { kind: "ref", typeIdx: innerInfo.stateTypeIdx };
      const innerResRef: ValType = { kind: "ref", typeIdx: innerInfo.resultTypeIdx };
      const delegLocal = allocLocal(fctx, `__gen_deleg_${fctx.locals.length}`, innerStateRef);
      const innerResLocal = allocLocal(fctx, `__gen_innerres_${fctx.locals.length}`, innerResRef);

      // Spill any straight-line locals computed in this state's prelude BEFORE
      // suspending; the delegation slot itself lives in the struct already.
      body.push(...storeSpills(info, fctx, selfLocal));

      // Lazily materialize the inner generator on first entry: if the slot is
      // null, construct `<inner>()` and store it.
      const constructInner: Instr[] = [];
      {
        const savedC = fctx.body;
        fctx.body = constructInner;
        compileNativeGeneratorFunction(ctx, fctx, innerInfo.decl, innerInfo);
        fctx.body = savedC;
      }
      body.push({ op: "local.get", index: selfLocal });
      body.push({ op: "struct.get", typeIdx: info.stateTypeIdx, fieldIdx: slot.fieldIdx });
      body.push({ op: "ref.is_null" });
      body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: selfLocal },
          ...constructInner,
          { op: "struct.set", typeIdx: info.stateTypeIdx, fieldIdx: slot.fieldIdx } as Instr,
        ],
        else: [],
      });

      // deleg (non-null) → local; drive its resume once.
      body.push({ op: "local.get", index: selfLocal });
      body.push({ op: "struct.get", typeIdx: info.stateTypeIdx, fieldIdx: slot.fieldIdx });
      body.push({ op: "ref.as_non_null" } as Instr);
      body.push({ op: "local.set", index: delegLocal });
      body.push({ op: "local.get", index: delegLocal });
      body.push({ op: "call", funcIdx: innerResumeIdx });
      body.push({ op: "local.set", index: innerResLocal });

      // if (innerRes.done == 0) re-yield innerRes.value (stay in THIS state)
      const doneArm: Instr[] = [
        // inner done — clear the slot, advance to the successor state, re-enter.
        { op: "local.get", index: selfLocal },
        { op: "ref.null", typeIdx: innerInfo.stateTypeIdx },
        { op: "struct.set", typeIdx: info.stateTypeIdx, fieldIdx: slot.fieldIdx } as Instr,
        ...setStateInstrs(info, selfLocal, term.next),
        { op: "br", depth: loopDepth + 1 }, // +1 for the inner `if`
      ];
      const yieldArm: Instr[] = [
        // inner yielded — stay in THIS state so the next .next() re-drives it.
        ...setStateInstrs(info, selfLocal, stateId),
        ...setModeInstrs(info, selfLocal, 0),
        { op: "local.get", index: innerResLocal },
        { op: "struct.get", typeIdx: innerInfo.resultTypeIdx, fieldIdx: RESULT_VALUE_FIELD },
        { op: "i32.const", value: 0 },
        { op: "struct.new", typeIdx: info.resultTypeIdx },
        { op: "local.set", index: resultLocal },
        { op: "br", depth: exitDepth + 1 }, // +1 for the inner `if`
      ];
      body.push({ op: "local.get", index: innerResLocal });
      body.push({ op: "struct.get", typeIdx: innerInfo.resultTypeIdx, fieldIdx: RESULT_DONE_FIELD });
      body.push({ op: "if", blockType: { kind: "empty" }, then: doneArm, else: yieldArm });
      break;
    }
  }

  fctx.body = saved;
  ctx.liveBodies.delete(saved);
  return body;
}

export function ensureNativeGeneratorResumeFunction(ctx: CodegenContext, info: NativeGeneratorInfo): number {
  if (info.resumeFuncIdx !== undefined) return info.resumeFuncIdx;

  const fnName = `__gen_resume_${sanitizeTypeName(info.functionName)}`;
  const existing = ctx.funcMap.get(fnName);
  if (existing !== undefined) {
    info.resumeFuncIdx = existing;
    return existing;
  }

  const selfType: ValType = { kind: "ref", typeIdx: info.stateTypeIdx };
  const resultType: ValType = { kind: "ref", typeIdx: info.resultTypeIdx };
  const typeIdx = addFuncType(ctx, [selfType], [resultType], `${fnName}_type`);
  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  info.resumeFuncIdx = funcIdx;
  ctx.funcMap.set(fnName, funcIdx);

  // #2079: reserve this function's slot with a placeholder BEFORE emitting the
  // body. The Phase-2 body can lazily register helper functions (numeric
  // operators like `%`/`**`, coercions, …) which append to `ctx.mod.functions`
  // and would otherwise push the real resume function past `funcIdx` — a stale
  // capture: every baked `call funcIdx` (the for-of driver, `.next()` dispatch)
  // would hit the helper instead of resume. Reserving the slot now keeps
  // `funcIdx` stable; we fill the placeholder body in place at the end. (Same
  // late-shift class as #1677/#1809/#1899; same fix idiom as the accessor
  // drivers.)
  const placeholder: WasmFunction = {
    name: fnName,
    typeIdx,
    locals: [],
    body: [{ op: "unreachable" } as Instr],
    exported: false,
  };
  ctx.mod.functions.push(placeholder);

  const resumeFctx: FunctionContext = {
    name: fnName,
    params: [{ name: "__gen_self", type: selfType }],
    locals: [],
    localMap: new Map([["__gen_self", 0]]),
    returnType: resultType,
    body: [],
    blockDepth: 0,
    breakStack: [],
    continueStack: [],
    labelMap: new Map(),
    savedBodies: [],
  };

  // Copy params into locals.
  for (let i = 0; i < info.paramTypes.length; i++) {
    const localIdx = allocLocal(resumeFctx, info.paramNames[i]!, info.paramTypes[i]!);
    resumeFctx.body.push({ op: "local.get", index: 0 });
    resumeFctx.body.push({ op: "struct.get", typeIdx: info.stateTypeIdx, fieldIdx: info.paramFieldOffset + i });
    resumeFctx.body.push({ op: "local.set", index: localIdx });
  }

  // Load spills into locals. (#2864 F1b) The load local is minted at the spill's
  // actual ValType so the `struct.get` (of the same-typed field) round-trips. The
  // body's var-declaration reuses this exact slot (it is already in `localMap`),
  // and because the resume fctx carries no analysis caches, its computed type
  // equals `resolveSpillLocalValType` → no slot re-type, no mismatch.
  for (let i = 0; i < info.spillNames.length; i++) {
    const localIdx = allocLocal(resumeFctx, info.spillNames[i]!, info.spillTypes[i]!);
    resumeFctx.body.push({ op: "local.get", index: 0 });
    resumeFctx.body.push({ op: "struct.get", typeIdx: info.stateTypeIdx, fieldIdx: info.spillFieldOffset + i });
    resumeFctx.body.push({ op: "local.set", index: localIdx });
  }

  // Result holding local (the trampoline writes it; the tail reads it).
  const resultLocal = allocLocal(resumeFctx, "__gen_result", { kind: "ref", typeIdx: info.resultTypeIdx });

  const plan = buildNativeGeneratorPlan(ctx, info.decl);
  if (!plan) {
    reportError(ctx, info.decl, "Internal error: native generator plan disappeared during emission");
    resumeFctx.body.push(...emptyResult(info));
  } else {
    const savedFunc = ctx.currentFunc;
    ctx.currentFunc = resumeFctx;
    try {
      resumeFctx.body.push(...emitTrampoline(ctx, resumeFctx, info, plan, 0, resultLocal));
    } finally {
      ctx.currentFunc = savedFunc;
    }
  }

  // (#2864 F1b) Reconcile each spill's struct field with the FINAL type its
  // resume-function local settled on. The body's var-declaration reuses the
  // pre-allocated spill slot and may re-type it (e.g. a predicted `ref_null`
  // narrowed by the declaration to a non-null `ref`); a non-null ref has no
  // struct-construction default and would not round-trip through `struct.get`,
  // so widen it back to `ref_null` and pin BOTH the local slot and the spill
  // field (+ `info.spillTypes`, which the constructor's init default reads) to
  // that common type. This runs before any `struct.new` of the state struct —
  // the constructor (`compileNativeGeneratorFunction`) calls this function
  // first — so the init defaults observe the reconciled types.
  const stateStruct = ctx.mod.types[info.stateTypeIdx];
  for (let i = 0; i < info.spillNames.length; i++) {
    const localIdx = resumeFctx.localMap.get(info.spillNames[i]!);
    if (localIdx === undefined || localIdx < resumeFctx.params.length) continue;
    const slot = resumeFctx.locals[localIdx - resumeFctx.params.length];
    if (!slot) continue;
    let finalType = slot.type;
    if (finalType.kind === "ref") finalType = { kind: "ref_null", typeIdx: finalType.typeIdx };
    slot.type = finalType;
    info.spillTypes[i] = finalType;
    if (stateStruct && stateStruct.kind === "struct") {
      const field = stateStruct.fields[info.spillFieldOffset + i];
      if (field) field.type = finalType;
    }
  }

  // Fill the reserved placeholder in place — its index (funcIdx) stayed stable
  // while body compilation appended any helper functions after it.
  placeholder.locals = resumeFctx.locals;
  placeholder.body = resumeFctx.body;
  return funcIdx;
}

export function compileNativeGeneratorFunction(
  ctx: CodegenContext,
  fctx: FunctionContext,
  decl: GeneratorDecl,
  info: NativeGeneratorInfo,
): void {
  ensureNativeGeneratorResumeFunction(ctx, info);
  // Construct the state struct: state=0, sent=⊥, mode=0, abrupt=⊥, params…, spills(NaN)…
  // (#2864 F1) `sent`/`abrupt` init to the carrier default — `f64 NaN` for the
  // numeric/string carriers (unchanged) or a null externref for the boxed-any
  // carrier so the struct.new typechecks before the first `.next(v)`.
  const carrierInit: Instr = carrierIsAny(info.elemValType)
    ? ({ op: "ref.null.extern" } as Instr)
    : { op: "f64.const", value: NaN };
  fctx.body.push({ op: "i32.const", value: 0 }); // state
  fctx.body.push(carrierInit); // sent
  fctx.body.push({ op: "i32.const", value: 0 }); // mode = MODE_NEXT
  fctx.body.push(carrierInit); // abrupt
  fctx.body.push({ op: "ref.null.extern" } as Instr); // (#2864 F2) error
  // (#2571) Read every wasm param into its `param_*` state slot. For an instance
  // method generator the synthetic `this` is wasm param 0 and user params are
  // 1..n, so iterate `info.paramTypes.length` (which includes the synthetic
  // `this`), NOT `decl.parameters.length`. For free functions / static methods
  // the two are equal, so this is byte-identical there.
  for (let i = 0; i < info.paramTypes.length; i++) {
    fctx.body.push({ op: "local.get", index: i });
  }
  // (#2864 F1b) Spill slots start at their type's inert default — `f64 NaN`
  // (numeric, unchanged), `i32`/`i64` 0, a null ref for object/string spills, or
  // a null externref for boxed-any spills — so the `struct.new` typechecks before
  // the body's declaration overwrites the slot on first entry.
  for (let i = 0; i < info.spillNames.length; i++) {
    fctx.body.push(defaultSpillInstr(info.spillTypes[i]!));
  }
  // (#2170) `yield*` delegation slots start null — the inner generator is
  // materialized lazily on first entry into the yield-star state.
  for (const slot of info.delegationSlots ?? []) {
    const innerInfo = ctx.nativeGenerators.get(slot.innerName);
    if (innerInfo) {
      fctx.body.push({ op: "ref.null", typeIdx: innerInfo.stateTypeIdx });
    } else {
      fctx.body.push({ op: "ref.null.eq" });
    }
  }
  fctx.body.push({ op: "struct.new", typeIdx: info.stateTypeIdx });
}

function nativeInfoForStateType(ctx: CodegenContext, typeIdx: number): NativeGeneratorInfo | undefined {
  for (const info of ctx.nativeGenerators.values()) {
    if (info.stateTypeIdx === typeIdx) return info;
  }
  return undefined;
}

// (#2171) Reverse-lookup a generator info by its result-struct typeIdx (used to
// recover the element ValType of an `it.next()` result whose type is a per-elem
// result struct, not the f64 singleton).
function resultInfoForType(ctx: CodegenContext, typeIdx: number): NativeGeneratorInfo | undefined {
  for (const info of ctx.nativeGenerators.values()) {
    if (info.resultTypeIdx === typeIdx) return info;
  }
  return undefined;
}

function isNativeResultType(ctx: CodegenContext, type: ValType | null): boolean {
  if (!type || (type.kind !== "ref" && type.kind !== "ref_null")) return false;
  const idx = type.typeIdx;
  if (ctx.nativeGeneratorResultTypeIdx >= 0 && idx === ctx.nativeGeneratorResultTypeIdx) return true;
  // (#2171) Result types are per-elem-kind (numeric f64 vs native string), so a
  // string generator's result struct is a distinct typeIdx. Recognize any
  // registered generator's result type.
  for (const info of ctx.nativeGenerators.values()) {
    if (info.resultTypeIdx === idx) return true;
  }
  return false;
}

function compileIgnoredArgs(ctx: CodegenContext, fctx: FunctionContext, args: readonly ts.Expression[]): void {
  for (const arg of args) {
    const argType = compileExpression(ctx, fctx, arg);
    if (argType !== null) fctx.body.push({ op: "drop" });
  }
}

function compileDirectNativeGeneratorMethod(
  ctx: CodegenContext,
  fctx: FunctionContext,
  info: NativeGeneratorInfo,
  receiverType: ValType,
  methodName: string,
  args: readonly ts.Expression[],
): ValType | null | undefined {
  if (receiverType.kind === "ref_null") {
    fctx.body.push({ op: "ref.as_non_null" });
  }
  const selfLocal = allocLocal(fctx, `__native_gen_self_${fctx.locals.length}`, {
    kind: "ref",
    typeIdx: info.stateTypeIdx,
  });
  fctx.body.push({ op: "local.set", index: selfLocal });

  if (methodName === "throw") {
    // (#2864 F2) `gen.throw(e)` — §27.5.3.4 GeneratorResumeAbrupt(throw).
    // Compile the error to externref into the dedicated error slot, then:
    //   • SUSPENDED (state != start && state != done): set mode=2 and resume —
    //     the resume function runs enclosing finalizers and re-throws (this slice
    //     has no try/catch-across-yield, so it always propagates).
    //   • NOT-STARTED / DONE: complete the generator and throw the error directly.
    const errorTmp = allocLocal(fctx, `__native_gen_err_${fctx.locals.length}`, { kind: "externref" });
    if (args[0]) {
      const t = compileExpression(ctx, fctx, args[0], { kind: "externref" });
      if (t && t.kind !== "externref") coerceType(ctx, fctx, t, { kind: "externref" });
      else if (!t) fctx.body.push({ op: "ref.null.extern" });
    } else {
      fctx.body.push({ op: "ref.null.extern" });
    }
    fctx.body.push({ op: "local.set", index: errorTmp });
    compileIgnoredArgs(ctx, fctx, args.slice(1));

    const tagIdx = ensureExnTag(ctx);
    // suspended = (state != START) && (state != doneState)
    fctx.body.push({ op: "local.get", index: selfLocal });
    fctx.body.push({ op: "struct.get", typeIdx: info.stateTypeIdx, fieldIdx: STATE_FIELD });
    fctx.body.push({ op: "i32.const", value: 0 });
    fctx.body.push({ op: "i32.ne" });
    fctx.body.push({ op: "local.get", index: selfLocal });
    fctx.body.push({ op: "struct.get", typeIdx: info.stateTypeIdx, fieldIdx: STATE_FIELD });
    fctx.body.push({ op: "i32.const", value: info.doneState });
    fctx.body.push({ op: "i32.ne" });
    fctx.body.push({ op: "i32.and" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: { kind: "ref", typeIdx: info.resultTypeIdx } },
      then: [
        { op: "local.get", index: selfLocal },
        { op: "local.get", index: errorTmp },
        { op: "struct.set", typeIdx: info.stateTypeIdx, fieldIdx: ERROR_FIELD },
        ...setStateI32FromConst(info, selfLocal, info.modeFieldIdx, MODE_THROW),
        { op: "local.get", index: selfLocal },
        { op: "call", funcIdx: ensureNativeGeneratorResumeFunction(ctx, info) },
      ],
      else: [
        // Not-started / completed: mark done and throw the error to the caller.
        ...setStateI32FromConst(info, selfLocal, STATE_FIELD, info.doneState),
        { op: "local.get", index: errorTmp },
        { op: "throw", tagIdx } as Instr,
      ],
    });
    return { kind: "ref", typeIdx: info.resultTypeIdx };
  }

  if (methodName === "next") {
    const sentTmp = emitCarrierValue(ctx, fctx, args[0], info);
    compileIgnoredArgs(ctx, fctx, args.slice(1));
    fctx.body.push(...setStateFieldFromLocal(info, selfLocal, info.sentFieldIdx, sentTmp));
    fctx.body.push(...setStateI32FromConst(info, selfLocal, info.modeFieldIdx, 0));
    fctx.body.push({ op: "local.get", index: selfLocal });
    fctx.body.push({ op: "call", funcIdx: ensureNativeGeneratorResumeFunction(ctx, info) });
    return { kind: "ref", typeIdx: info.resultTypeIdx };
  }

  if (methodName === "return") {
    const valueTmp = emitCarrierValue(ctx, fctx, args[0], info);
    compileIgnoredArgs(ctx, fctx, args.slice(1));
    fctx.body.push({ op: "local.get", index: selfLocal });
    fctx.body.push({ op: "struct.get", typeIdx: info.stateTypeIdx, fieldIdx: STATE_FIELD });
    fctx.body.push({ op: "i32.const", value: 0 });
    fctx.body.push({ op: "i32.eq" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: { kind: "ref", typeIdx: info.resultTypeIdx } },
      then: [
        ...setStateI32FromConst(info, selfLocal, STATE_FIELD, info.doneState),
        ...setStateI32FromConst(info, selfLocal, info.modeFieldIdx, 0),
        ...nativeReturnResultFromLocal(info, valueTmp),
      ],
      else: [
        { op: "local.get", index: selfLocal },
        { op: "struct.get", typeIdx: info.stateTypeIdx, fieldIdx: STATE_FIELD },
        { op: "i32.const", value: info.doneState },
        { op: "i32.eq" },
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "ref", typeIdx: info.resultTypeIdx } },
          then: [
            ...setStateI32FromConst(info, selfLocal, info.modeFieldIdx, 0),
            ...nativeReturnResultFromLocal(info, valueTmp),
          ],
          else: [
            ...setStateFieldFromLocal(info, selfLocal, info.abruptFieldIdx, valueTmp),
            ...setStateI32FromConst(info, selfLocal, info.modeFieldIdx, 1),
            { op: "local.get", index: selfLocal },
            { op: "call", funcIdx: ensureNativeGeneratorResumeFunction(ctx, info) },
          ],
        },
      ],
    });
    return { kind: "ref", typeIdx: info.resultTypeIdx };
  }

  return undefined;
}

function buildNativeGeneratorDispatch(
  ctx: CodegenContext,
  anyLocal: number,
  methodName: string,
  valueLocal?: number,
  // (#2864 F1) The boxed-`any` carrier's `sent`/`abrupt`/result are externref.
  // When the dispatch chain includes an any-carrier generator the caller emits
  // the `.next(v)`/`.return(v)` argument BOTH as f64 (`valueLocal`, for numeric /
  // string branches, unchanged) AND as externref (`valueAnyLocal`, for any
  // branches). When no any-carrier generator participates this is undefined and
  // the dispatch is byte-identical to pre-#2864.
  valueAnyLocal?: number,
  // (#2864 F2) externref error local for `.throw(e)`.
  errorLocal?: number,
): { instrs: Instr[]; resultType: ValType } {
  const infos = Array.from(ctx.nativeGenerators.values());
  // (#2864 F1) When ANY generator in the chain uses the boxed-any carrier, the
  // enclosing block must accept every carrier's result struct, so its type is
  // `eqref` (the common supertype) and the chain produces concrete result
  // structs (eqref subtypes). For numeric/string-only modules (the existing,
  // dominant case) there is no any carrier — keep the f64 IteratorResult
  // singleton block type, byte-identical to before, so no numeric generator
  // regresses.
  const hasAny = infos.some((i) => carrierIsAny(i.elemValType));
  const resultType: ValType = hasAny
    ? { kind: "eqref" }
    : { kind: "ref", typeIdx: ensureNativeGeneratorResultType(ctx) };
  // The per-branch `.next(v)`/`.return(v)` value local: an any-carrier branch
  // consumes the externref `valueAnyLocal`; numeric / string branches consume the
  // f64 `valueLocal` (unchanged). `valueLocal` is always present when valueAnyLocal
  // is (the caller derives one from the other).
  const branchValueLocal = (info: NativeGeneratorInfo): number =>
    carrierIsAny(info.elemValType) ? valueAnyLocal! : valueLocal!;
  // #1344 — the receiver matched NONE of the native generator state types, i.e.
  // `[[GeneratorState]]` is absent (e.g. `GeneratorPrototype.next.call({})`).
  // Per §27.5.3.2 GeneratorValidate step 2 / §27.5.1.2-4, throw a *catchable*
  // TypeError (a real `__new_TypeError` instance + `throw $exc`), never the old
  // silent `{value: 0, done: true}` sentinel. `throw` is stack-polymorphic, so
  // it satisfies the enclosing block's `resultType` without leaving a value.
  const fallback: Instr[] = [];
  emitBrandCheckTypeError(ctx, fallback, `Generator.prototype.${methodName} requires that 'this' be a Generator`);

  function branch(index: number): Instr[] {
    if (index >= infos.length) return fallback;
    const info = infos[index]!;
    const vLocal = branchValueLocal(info);
    let thenBody: Instr[];
    if (methodName === "throw") {
      // (#2864 F2) `gen.throw(e)` — suspended: write the error, set mode=2, and
      // resume (the resume function runs enclosing finalizers then re-throws);
      // not-started / done: complete and throw the error directly. Mirrors the
      // direct-path throw. `throw` is stack-polymorphic so the not-started/done
      // arm satisfies the block's `resultType` without leaving a value.
      const tagIdx = ensureExnTag(ctx);
      thenBody = [
        { op: "local.get", index: anyLocal },
        { op: "ref.cast", typeIdx: info.stateTypeIdx },
        { op: "struct.get", typeIdx: info.stateTypeIdx, fieldIdx: STATE_FIELD },
        { op: "i32.const", value: 0 },
        { op: "i32.ne" },
        { op: "local.get", index: anyLocal },
        { op: "ref.cast", typeIdx: info.stateTypeIdx },
        { op: "struct.get", typeIdx: info.stateTypeIdx, fieldIdx: STATE_FIELD },
        { op: "i32.const", value: info.doneState },
        { op: "i32.ne" },
        { op: "i32.and" },
        {
          op: "if",
          blockType: { kind: "val", type: resultType },
          then: [
            { op: "local.get", index: anyLocal },
            { op: "ref.cast", typeIdx: info.stateTypeIdx },
            { op: "local.get", index: errorLocal! },
            { op: "struct.set", typeIdx: info.stateTypeIdx, fieldIdx: ERROR_FIELD },
            { op: "local.get", index: anyLocal },
            { op: "ref.cast", typeIdx: info.stateTypeIdx },
            { op: "i32.const", value: MODE_THROW },
            { op: "struct.set", typeIdx: info.stateTypeIdx, fieldIdx: info.modeFieldIdx },
            { op: "local.get", index: anyLocal },
            { op: "ref.cast", typeIdx: info.stateTypeIdx },
            { op: "call", funcIdx: ensureNativeGeneratorResumeFunction(ctx, info) },
          ],
          else: [
            { op: "local.get", index: anyLocal },
            { op: "ref.cast", typeIdx: info.stateTypeIdx },
            { op: "i32.const", value: info.doneState },
            { op: "struct.set", typeIdx: info.stateTypeIdx, fieldIdx: STATE_FIELD },
            { op: "local.get", index: errorLocal! },
            { op: "throw", tagIdx } as Instr,
          ],
        },
      ];
    } else if (methodName === "next") {
      thenBody = [
        { op: "local.get", index: anyLocal },
        { op: "ref.cast", typeIdx: info.stateTypeIdx },
        { op: "local.get", index: vLocal },
        { op: "struct.set", typeIdx: info.stateTypeIdx, fieldIdx: info.sentFieldIdx },
        { op: "local.get", index: anyLocal },
        { op: "ref.cast", typeIdx: info.stateTypeIdx },
        { op: "i32.const", value: 0 },
        { op: "struct.set", typeIdx: info.stateTypeIdx, fieldIdx: info.modeFieldIdx },
        { op: "local.get", index: anyLocal },
        { op: "ref.cast", typeIdx: info.stateTypeIdx },
        { op: "call", funcIdx: ensureNativeGeneratorResumeFunction(ctx, info) },
      ];
    } else {
      thenBody = [
        { op: "local.get", index: anyLocal },
        { op: "ref.cast", typeIdx: info.stateTypeIdx },
        { op: "struct.get", typeIdx: info.stateTypeIdx, fieldIdx: STATE_FIELD },
        { op: "i32.const", value: 0 },
        { op: "i32.eq" },
        {
          op: "if",
          blockType: { kind: "val", type: resultType },
          then: [
            { op: "local.get", index: anyLocal },
            { op: "ref.cast", typeIdx: info.stateTypeIdx },
            { op: "i32.const", value: info.doneState },
            { op: "struct.set", typeIdx: info.stateTypeIdx, fieldIdx: STATE_FIELD },
            { op: "local.get", index: anyLocal },
            { op: "ref.cast", typeIdx: info.stateTypeIdx },
            { op: "i32.const", value: 0 },
            { op: "struct.set", typeIdx: info.stateTypeIdx, fieldIdx: info.modeFieldIdx },
            { op: "local.get", index: vLocal },
            { op: "i32.const", value: 1 },
            { op: "struct.new", typeIdx: info.resultTypeIdx },
          ],
          else: [
            { op: "local.get", index: anyLocal },
            { op: "ref.cast", typeIdx: info.stateTypeIdx },
            { op: "struct.get", typeIdx: info.stateTypeIdx, fieldIdx: STATE_FIELD },
            { op: "i32.const", value: info.doneState },
            { op: "i32.eq" },
            {
              op: "if",
              blockType: { kind: "val", type: resultType },
              then: [
                { op: "local.get", index: anyLocal },
                { op: "ref.cast", typeIdx: info.stateTypeIdx },
                { op: "i32.const", value: 0 },
                { op: "struct.set", typeIdx: info.stateTypeIdx, fieldIdx: info.modeFieldIdx },
                { op: "local.get", index: vLocal },
                { op: "i32.const", value: 1 },
                { op: "struct.new", typeIdx: info.resultTypeIdx },
              ],
              else: [
                { op: "local.get", index: anyLocal },
                { op: "ref.cast", typeIdx: info.stateTypeIdx },
                { op: "local.get", index: vLocal },
                { op: "struct.set", typeIdx: info.stateTypeIdx, fieldIdx: info.abruptFieldIdx },
                { op: "local.get", index: anyLocal },
                { op: "ref.cast", typeIdx: info.stateTypeIdx },
                { op: "i32.const", value: 1 },
                { op: "struct.set", typeIdx: info.stateTypeIdx, fieldIdx: info.modeFieldIdx },
                { op: "local.get", index: anyLocal },
                { op: "ref.cast", typeIdx: info.stateTypeIdx },
                { op: "call", funcIdx: ensureNativeGeneratorResumeFunction(ctx, info) },
              ],
            },
          ],
        },
      ];
    }
    return [
      { op: "local.get", index: anyLocal },
      { op: "ref.test", typeIdx: info.stateTypeIdx },
      {
        op: "if",
        blockType: { kind: "val", type: resultType },
        then: thenBody,
        else: branch(index + 1),
      },
    ];
  }
  return { instrs: branch(0), resultType };
}

export function tryCompileNativeGeneratorMethodCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  receiverExpr: ts.Expression,
  methodName: string,
  args: readonly ts.Expression[],
): ValType | null | undefined {
  if (methodName !== "next" && methodName !== "return" && methodName !== "throw") return undefined;
  if (ctx.nativeGenerators.size === 0) return undefined;

  const receiverType = compileExpression(ctx, fctx, receiverExpr);
  if (receiverType && (receiverType.kind === "ref" || receiverType.kind === "ref_null")) {
    const info = nativeInfoForStateType(ctx, receiverType.typeIdx);
    if (info) {
      return compileDirectNativeGeneratorMethod(ctx, fctx, info, receiverType, methodName, args);
    }
  }

  if (receiverType?.kind === "externref") {
    fctx.body.push({ op: "any.convert_extern" });
  } else if (!receiverType || (receiverType.kind !== "anyref" && receiverType.kind !== "eqref")) {
    if (receiverType !== null) fctx.body.push({ op: "drop" });
    compileIgnoredArgs(ctx, fctx, args);
    fctx.body.push(...emptyResultForType(ensureNativeGeneratorResultType(ctx)));
    return { kind: "ref", typeIdx: ctx.nativeGeneratorResultTypeIdx };
  }

  const anyLocal = allocLocal(fctx, `__native_gen_any_${fctx.locals.length}`, { kind: "anyref" });
  fctx.body.push({ op: "local.set", index: anyLocal });

  // (#2864 F1) When the open dispatch must service an any-carrier generator, the
  // `.next(v)`/`.return(v)` argument is needed BOTH as externref (any branches)
  // and as f64 (numeric / string branches). Compile it ONCE to externref (its
  // natural representation when `it` is statically opaque), then derive the f64
  // by unboxing — so a side-effecting argument is evaluated exactly once. For
  // numeric/string-only modules (no any carrier) keep the historical f64-only
  // emission, byte-identical to before.
  const dispatchHasAny = Array.from(ctx.nativeGenerators.values()).some((i) => carrierIsAny(i.elemValType));
  let valueLocal: number | undefined;
  let valueAnyLocal: number | undefined;
  let errorLocal: number | undefined;
  if (methodName === "throw") {
    // (#2864 F2) The thrown value is an externref error, independent of any
    // generator's carrier — store it in a dedicated local for the dispatch's
    // throw branch (which writes it to the state struct's `error` field).
    errorLocal = allocLocal(fctx, `__gen_throw_err_${fctx.locals.length}`, { kind: "externref" });
    if (args[0]) {
      const t = compileExpression(ctx, fctx, args[0], { kind: "externref" });
      if (t && t.kind !== "externref") coerceType(ctx, fctx, t, { kind: "externref" });
      else if (!t) fctx.body.push({ op: "ref.null.extern" });
    } else {
      fctx.body.push({ op: "ref.null.extern" });
    }
    fctx.body.push({ op: "local.set", index: errorLocal });
    compileIgnoredArgs(ctx, fctx, args.slice(1));
  } else if (methodName === "return" || methodName === "next") {
    if (dispatchHasAny) {
      valueAnyLocal = emitOpenAnyArgValue(ctx, fctx, args[0]);
      compileIgnoredArgs(ctx, fctx, args.slice(1));
      valueLocal = allocLocal(fctx, `__gen_sent_f64_${fctx.locals.length}`, { kind: "f64" });
      fctx.body.push({ op: "local.get", index: valueAnyLocal });
      coerceType(ctx, fctx, { kind: "externref" }, { kind: "f64" });
      fctx.body.push({ op: "local.set", index: valueLocal });
    } else {
      valueLocal = emitExpressionAsF64(ctx, fctx, args[0]);
      compileIgnoredArgs(ctx, fctx, args.slice(1));
    }
  }

  const { instrs, resultType } = buildNativeGeneratorDispatch(
    ctx,
    anyLocal,
    methodName,
    valueLocal,
    valueAnyLocal,
    errorLocal,
  );
  fctx.body.push(...instrs);
  return resultType;
}

export function tryCompileNativeGeneratorResultProperty(
  ctx: CodegenContext,
  fctx: FunctionContext,
  resultExpr: ts.Expression,
  propName: string,
): ValType | null | undefined {
  if (propName !== "value" && propName !== "done") return undefined;
  // (#2171) Proceed if either the f64 singleton or any per-elem native
  // generator result type exists (a string-only module never sets the singleton).
  if (ctx.nativeGeneratorResultTypeIdx < 0 && ctx.nativeGenerators.size === 0) return undefined;

  const resultType = compileExpression(ctx, fctx, resultExpr);
  if (isNativeResultType(ctx, resultType)) {
    // (#2171) The result type may be the f64 singleton OR a per-elem-kind result
    // struct (e.g. native string). Read the value field at the matched result
    // type's typeIdx and report its element ValType, not the f64 singleton.
    const rtIdx = (resultType as { typeIdx: number }).typeIdx;
    const matchInfo = resultInfoForType(ctx, rtIdx);
    const valVT: ValType = matchInfo ? matchInfo.elemValType : { kind: "f64" };
    if (resultType?.kind === "ref_null") fctx.body.push({ op: "ref.as_non_null" });
    fctx.body.push({
      op: "struct.get",
      typeIdx: rtIdx,
      fieldIdx: propName === "value" ? RESULT_VALUE_FIELD : RESULT_DONE_FIELD,
    });
    return propName === "value" ? valVT : { kind: "i32" };
  }

  if (resultType?.kind === "externref") {
    fctx.body.push({ op: "any.convert_extern" });
  } else if (!resultType || (resultType.kind !== "anyref" && resultType.kind !== "eqref")) {
    if (resultType !== null) fctx.body.push({ op: "drop" });
    fctx.body.push(propName === "value" ? { op: "f64.const", value: 0 } : { op: "i32.const", value: 1 });
    return propName === "value" ? { kind: "f64" } : { kind: "i32" };
  }

  const anyLocal = allocLocal(fctx, `__native_gen_result_${fctx.locals.length}`, { kind: "anyref" });
  fctx.body.push({ op: "local.set", index: anyLocal });

  // (#2864 F1) Distinct IteratorResult struct types in this module: the f64
  // singleton (when present) plus each registered generator's per-elem result
  // type (native string, boxed-any externref). The open reader must runtime-test
  // every one, not just the f64 singleton — otherwise a `.done`/`.value` read off
  // an any-carrier result (which is NOT the singleton) fell through to the
  // default (`done:true` / `0`).
  const resultEntries: { typeIdx: number; elemValType: ValType }[] = [];
  const seenResult = new Set<number>();
  const pushEntry = (typeIdx: number, elem: ValType): void => {
    if (typeIdx >= 0 && !seenResult.has(typeIdx)) {
      seenResult.add(typeIdx);
      resultEntries.push({ typeIdx, elemValType: elem });
    }
  };
  if (ctx.nativeGeneratorResultTypeIdx >= 0) pushEntry(ctx.nativeGeneratorResultTypeIdx, { kind: "f64" });
  for (const info of ctx.nativeGenerators.values()) pushEntry(info.resultTypeIdx, info.elemValType);

  if (propName === "done") {
    // `done` is i32 for every carrier — test each result type, read field 1.
    fctx.body.push(buildOpenResultRead(anyLocal, resultEntries, RESULT_DONE_FIELD, { kind: "i32" }));
    return { kind: "i32" };
  }

  // `value`: choose the return ValType from the STATIC type of the result's
  // `value` property. A numeric generator keeps the f64 fast path (byte-identical
  // to before); an object / mixed (boxed-any) generator returns externref. This
  // is what keeps existing numeric `.next().value` reads unchanged.
  let valueWantsRef = false;
  const itType = ctx.checker.getTypeAtLocation(resultExpr);
  const valSym = itType.getProperty?.("value");
  if (valSym) {
    const mapped = mapTsTypeToWasm(ctx.checker.getTypeOfSymbolAtLocation(valSym, resultExpr), ctx.checker);
    valueWantsRef =
      mapped.kind === "externref" ||
      mapped.kind === "anyref" ||
      mapped.kind === "eqref" ||
      mapped.kind === "ref" ||
      mapped.kind === "ref_null";
  }

  if (valueWantsRef) {
    // Read the value off whichever boxed-any result type matched, leaving an
    // externref. Only the any-carrier (externref-elem) result types carry an
    // externref value; a numeric result's f64 value can't be returned here, so it
    // falls to the inert null default (a numeric value statically typed `any` is
    // not a shape F1 targets).
    const anyEntries = resultEntries.filter((e) => e.elemValType.kind === "externref");
    fctx.body.push(buildOpenResultRead(anyLocal, anyEntries, RESULT_VALUE_FIELD, { kind: "externref" }));
    return { kind: "externref" };
  }

  // Numeric value (or no static info): the historical f64-singleton fast path.
  const fieldType: ValType = { kind: "f64" };
  const f64Entries = resultEntries.filter((e) => e.elemValType.kind === "f64");
  fctx.body.push(buildOpenResultRead(anyLocal, f64Entries, RESULT_VALUE_FIELD, fieldType));
  return fieldType;
}

/**
 * (#2864 F1) Build a runtime ref.test chain over candidate IteratorResult struct
 * types, reading `fieldIdx` off the first match and leaving a `returnVT`. The
 * default (no match) is the inert value for the field: `i32.const 1` (done) /
 * `f64.const 0` / null externref. The matched struct's field type already equals
 * `returnVT` for both the f64 singleton (value f64 / done i32) and the boxed-any
 * result (value externref / done i32), so no per-entry coercion is needed.
 */
function buildOpenResultRead(
  anyLocal: number,
  entries: { typeIdx: number; elemValType: ValType }[],
  fieldIdx: number,
  returnVT: ValType,
): Instr {
  const def: Instr =
    fieldIdx === RESULT_DONE_FIELD
      ? { op: "i32.const", value: 1 }
      : returnVT.kind === "externref"
        ? ({ op: "ref.null.extern" } as Instr)
        : { op: "f64.const", value: 0 };
  // Each level emits its own `ref.test` condition then the `if`; the tail (no
  // match) yields the inert default.
  const wrap = (i: number): Instr[] => {
    if (i >= entries.length) return [def];
    const e = entries[i]!;
    return [
      { op: "local.get", index: anyLocal },
      { op: "ref.test", typeIdx: e.typeIdx },
      {
        op: "if",
        blockType: { kind: "val", type: returnVT },
        then: [
          { op: "local.get", index: anyLocal },
          { op: "ref.cast", typeIdx: e.typeIdx },
          { op: "struct.get", typeIdx: e.typeIdx, fieldIdx },
        ],
        else: wrap(i + 1),
      } as Instr,
    ];
  };
  // Wrap the chain in a single block so the caller pushes exactly one Instr.
  return { op: "block", blockType: { kind: "val", type: returnVT }, body: wrap(0) } as Instr;
}

/**
 * Look up a native-generator info by the **TS type** of a for-of subject
 * expression, mapping the resolved wasm state struct typeIdx back to its
 * NativeGeneratorInfo. Returns undefined when the subject is not a native
 * generator value.
 */
export function nativeGeneratorInfoForForOfSubject(
  ctx: CodegenContext,
  subjectType: ValType,
): NativeGeneratorInfo | undefined {
  if (subjectType.kind !== "ref" && subjectType.kind !== "ref_null") return undefined;
  return nativeInfoForStateType(ctx, subjectType.typeIdx);
}

/**
 * #1665 — drive a `for (… of gen())` loop over a Wasm-native generator state
 * machine WITHOUT the JS-host iterator protocol. The generator state ref is
 * expected to already be on the stack (the caller compiled the iterable
 * expression); `subjectType` is its ValType.
 *
 * Emits, structurally identical to the host iterator loop but calling the
 * generator's resume function directly:
 *
 *   iter = <subject>
 *   block:
 *     loop:
 *       res = __gen_resume_<g>(iter)        ;; ref $result {value:f64, done:i32}
 *       if (res.done) br block
 *       elem = res.value                    ;; f64 (or coerced to elem decl type)
 *       <body>
 *       br loop
 *
 * Only numeric (f64) yields are supported by the existing native generator
 * (`isNativeGeneratorCandidate`), so the loop variable is f64. Returns true on
 * success; false (with the stack untouched-by-contract: caller resets) when the
 * shape is unsupported so the caller can fall back.
 */
export function tryCompileNativeGeneratorForOf(
  ctx: CodegenContext,
  fctx: FunctionContext,
  stmt: ts.ForOfStatement,
  subjectType: ValType,
  info: NativeGeneratorInfo,
): boolean {
  // for-await-of over a sync generator is not supported here.
  if (stmt.awaitModifier) return false;
  // Only plain identifier / simple binding loop variables in this slice;
  // destructuring over a numeric generator value is meaningless (f64 isn't
  // destructurable) and array/object patterns fall back.
  let loopVarName: string | undefined;
  let isConst = false;
  if (ts.isVariableDeclarationList(stmt.initializer)) {
    const decl = stmt.initializer.declarations[0]!;
    if (!ts.isIdentifier(decl.name)) return false;
    loopVarName = decl.name.text;
    isConst = !!(stmt.initializer.flags & ts.NodeFlags.Const);
  } else if (ts.isIdentifier(stmt.initializer)) {
    loopVarName = stmt.initializer.text;
  } else {
    return false;
  }

  // The caller only reaches here when nativeGeneratorInfoForForOfSubject
  // matched, i.e. subjectType is a ref/ref_null to the generator state struct.
  if (subjectType.kind !== "ref" && subjectType.kind !== "ref_null") return false;
  const subjectTypeIdx = subjectType.typeIdx;

  const resumeIdx = ensureNativeGeneratorResumeFunction(ctx, info);
  const resultRef: ValType = { kind: "ref", typeIdx: info.resultTypeIdx };

  // Stash the generator state ref (currently on stack) into a local typed as
  // the exact state struct (it always is; the static type may be ref_null).
  const iterLocal = allocLocal(fctx, `__nativegen_iter_${fctx.locals.length}`, {
    kind: "ref",
    typeIdx: info.stateTypeIdx,
  } as ValType);
  if (subjectType.kind === "ref_null") {
    fctx.body.push({ op: "ref.as_non_null" });
  }
  if (subjectTypeIdx !== info.stateTypeIdx) {
    fctx.body.push({ op: "ref.cast", typeIdx: info.stateTypeIdx });
  }
  fctx.body.push({ op: "local.set", index: iterLocal });

  const resultLocal = allocLocal(fctx, `__nativegen_res_${fctx.locals.length}`, resultRef);

  // Loop variable: the generator's element ValType (f64 numeric, or the native
  // string ref for a string generator — #2171). const-ness recorded so
  // shadowing/TDZ logic downstream stays consistent.
  const elemLocal = allocLocal(fctx, loopVarName, info.elemValType);
  if (isConst) {
    if (!fctx.constBindings) fctx.constBindings = new Set();
    fctx.constBindings.add(loopVarName);
  }

  // block { loop { … } } — break = depth 1 (exit block), continue = depth 0.
  const savedBody = pushBody(fctx);

  // Adjust existing break/continue/return/rethrow depths: block + loop add 2.
  for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]! += 2;
  for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]! += 2;
  if (fctx.generatorReturnDepth !== undefined) fctx.generatorReturnDepth += 2;

  fctx.breakStack.push(1);
  fctx.continueStack.push(0);

  // res = resume(iter)
  fctx.body.push({ op: "local.get", index: iterLocal });
  if (subjectType.typeIdx !== info.stateTypeIdx) {
    fctx.body.push({ op: "ref.cast", typeIdx: info.stateTypeIdx });
  }
  fctx.body.push({ op: "call", funcIdx: resumeIdx });
  fctx.body.push({ op: "local.set", index: resultLocal });

  // if (res.done) br block (depth 1: exit loop+block ⇒ depth to block is 1)
  fctx.body.push({ op: "local.get", index: resultLocal });
  fctx.body.push({ op: "struct.get", typeIdx: info.resultTypeIdx, fieldIdx: RESULT_DONE_FIELD });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [{ op: "br", depth: 2 } as Instr], // if + loop = depth 2 to exit block
    else: [],
  });

  // elem = res.value
  fctx.body.push({ op: "local.get", index: resultLocal });
  fctx.body.push({ op: "struct.get", typeIdx: info.resultTypeIdx, fieldIdx: RESULT_VALUE_FIELD });
  fctx.body.push({ op: "local.set", index: elemLocal });

  // body
  if (ts.isBlock(stmt.statement)) {
    for (const s of stmt.statement.statements) {
      compileStatement(ctx, fctx, s);
    }
  } else {
    compileStatement(ctx, fctx, stmt.statement);
  }

  fctx.body.push({ op: "br", depth: 0 }); // continue loop

  const loopBody = fctx.body;
  fctx.breakStack.pop();
  fctx.continueStack.pop();

  // Restore depths.
  for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]! -= 2;
  for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]! -= 2;
  if (fctx.generatorReturnDepth !== undefined) fctx.generatorReturnDepth -= 2;

  popBody(fctx, savedBody);

  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [
      {
        op: "loop",
        blockType: { kind: "empty" },
        body: loopBody,
      } as Instr,
    ],
  });
  return true;
}

/**
 * #2169 — materialize a Wasm-native generator into a `__vec` of f64 by driving
 * its resume function to completion, WITHOUT the JS-host iterator protocol.
 *
 * The non-`for-of` iterator consumers (array spread `[...g()]`, `Array.from(g())`,
 * array-destructuring `[a,b]=g()`) previously treated the generator's state
 * struct as if it were a `__vec` (reading field 0 as a `$length`), producing a
 * garbage-length array of defaults / leaking host imports. This helper gives
 * them the same `next()`-until-`done` drain the for-of driver uses, but
 * collects the values into a growable backing array and leaves a freshly
 * constructed `ref $vec_f64` on the stack (so the caller can treat it as a
 * normal materialized vec).
 *
 * Contract: the generator state ref (`subjectType`, a ref/ref_null to the
 * `info.stateTypeIdx` struct) MUST already be on the stack. On return the stack
 * top is `(ref <vecTypeIdx>)` of element type f64. Numeric yields only (native
 * generators are numeric today; non-numeric is #2171 / SF-4).
 *
 * The vec struct layout matches `getVecInfo`: field 0 = `$length` (i32),
 * field 1 = `$data` (ref $arr). `vecTypeIdx`/`arrTypeIdx` are supplied by the
 * caller (an f64 vec from `getOrRegisterVecType`).
 *
 * `trimToLength` (#2169 destructure consumer): when true, the backing array is
 * resized to EXACTLY `len` before the final `struct.new`, so `array.len(data)`
 * equals the logical `$length`. The default (false) leaves the capacity-padded
 * array in place — fine for consumers that read the `$length` field (spread,
 * Array.from), but the array-destructuring path bounds-checks against
 * `array.len(data)` (`emitBoundsCheckedArrayGet`), so a capacity-padded array
 * would make an out-of-length index read a default-initialized `0.0` slot
 * instead of being OOB, silently skipping binding defaults (`const [a,b=9]=g()`
 * with one yield). Trimming restores the literal-array invariant the destructure
 * machinery relies on (backing-array length == logical length).
 */
export function emitNativeGeneratorToVec(
  ctx: CodegenContext,
  fctx: FunctionContext,
  info: NativeGeneratorInfo,
  subjectType: ValType,
  vecTypeIdx: number,
  arrTypeIdx: number,
  trimToLength = false,
): void {
  const resumeIdx = ensureNativeGeneratorResumeFunction(ctx, info);
  const resultRef: ValType = { kind: "ref", typeIdx: info.resultTypeIdx };

  // Stash the generator state ref (currently on stack) into a local typed as
  // the exact state struct.
  const iterLocal = allocLocal(fctx, `__gen2vec_iter_${fctx.locals.length}`, {
    kind: "ref",
    typeIdx: info.stateTypeIdx,
  } as ValType);
  if (subjectType.kind === "ref_null") {
    fctx.body.push({ op: "ref.as_non_null" });
  }
  if ((subjectType as { typeIdx?: number }).typeIdx !== info.stateTypeIdx) {
    fctx.body.push({ op: "ref.cast", typeIdx: info.stateTypeIdx });
  }
  fctx.body.push({ op: "local.set", index: iterLocal });

  const resultLocal = allocLocal(fctx, `__gen2vec_res_${fctx.locals.length}`, resultRef);
  const capLocal = allocLocal(fctx, `__gen2vec_cap_${fctx.locals.length}`, { kind: "i32" });
  const lenLocal = allocLocal(fctx, `__gen2vec_len_${fctx.locals.length}`, { kind: "i32" });
  const dataLocal = allocLocal(fctx, `__gen2vec_data_${fctx.locals.length}`, { kind: "ref", typeIdx: arrTypeIdx });
  const growLocal = allocLocal(fctx, `__gen2vec_grow_${fctx.locals.length}`, { kind: "ref", typeIdx: arrTypeIdx });

  // cap = 4; data = new f64[cap]; len = 0.
  fctx.body.push({ op: "i32.const", value: 4 });
  fctx.body.push({ op: "local.set", index: capLocal });
  fctx.body.push({ op: "local.get", index: capLocal });
  fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
  fctx.body.push({ op: "local.set", index: dataLocal });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: lenLocal });

  // Grow when len == cap: cap *= 2; grow = new f64[cap];
  // array.copy grow[0..len] = data[0..len]; data = grow.
  const growInstrs: Instr[] = [
    { op: "local.get", index: capLocal },
    { op: "i32.const", value: 2 },
    { op: "i32.mul" },
    { op: "local.set", index: capLocal },
    { op: "local.get", index: capLocal },
    { op: "array.new_default", typeIdx: arrTypeIdx },
    { op: "local.set", index: growLocal },
    { op: "local.get", index: growLocal },
    { op: "i32.const", value: 0 },
    { op: "local.get", index: dataLocal },
    { op: "i32.const", value: 0 },
    { op: "local.get", index: lenLocal },
    { op: "array.copy", dstTypeIdx: arrTypeIdx, srcTypeIdx: arrTypeIdx } as Instr,
    { op: "local.get", index: growLocal },
    { op: "local.set", index: dataLocal },
  ];

  // block { loop {
  //   res = resume(iter); if (res.done) br block;
  //   if (len == cap) grow; data[len] = res.value; len++; br loop;
  // } }
  const loopBody: Instr[] = [
    { op: "local.get", index: iterLocal },
    { op: "call", funcIdx: resumeIdx },
    { op: "local.set", index: resultLocal },
    { op: "local.get", index: resultLocal },
    { op: "struct.get", typeIdx: info.resultTypeIdx, fieldIdx: RESULT_DONE_FIELD },
    { op: "if", blockType: { kind: "empty" }, then: [{ op: "br", depth: 2 } as Instr], else: [] },
    // grow if full
    { op: "local.get", index: lenLocal },
    { op: "local.get", index: capLocal },
    { op: "i32.eq" },
    { op: "if", blockType: { kind: "empty" }, then: growInstrs, else: [] },
    // data[len] = res.value
    { op: "local.get", index: dataLocal },
    { op: "local.get", index: lenLocal },
    { op: "local.get", index: resultLocal },
    { op: "struct.get", typeIdx: info.resultTypeIdx, fieldIdx: RESULT_VALUE_FIELD },
    { op: "array.set", typeIdx: arrTypeIdx } as Instr,
    // len++
    { op: "local.get", index: lenLocal },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.set", index: lenLocal },
    { op: "br", depth: 0 },
  ];
  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [{ op: "loop", blockType: { kind: "empty" }, body: loopBody } as Instr],
  });

  // (#2169) Trim the backing array to exactly `len` when the consumer
  // bounds-checks against `array.len(data)` rather than the `$length` field
  // (array-destructuring). trimmed = new f64[len]; array.copy trimmed = data[0..len];
  // data = trimmed.
  if (trimToLength) {
    const trimLocal = allocLocal(fctx, `__gen2vec_trim_${fctx.locals.length}`, { kind: "ref", typeIdx: arrTypeIdx });
    fctx.body.push({ op: "local.get", index: lenLocal });
    fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
    fctx.body.push({ op: "local.set", index: trimLocal });
    fctx.body.push({ op: "local.get", index: trimLocal });
    fctx.body.push({ op: "i32.const", value: 0 });
    fctx.body.push({ op: "local.get", index: dataLocal });
    fctx.body.push({ op: "i32.const", value: 0 });
    fctx.body.push({ op: "local.get", index: lenLocal });
    fctx.body.push({ op: "array.copy", dstTypeIdx: arrTypeIdx, srcTypeIdx: arrTypeIdx } as Instr);
    fctx.body.push({ op: "local.get", index: trimLocal });
    fctx.body.push({ op: "local.set", index: dataLocal });
  }

  // Construct ref $vec { length: len, data }. When `trimToLength` is false the
  // backing array may be larger than len (capacity); the vec's $length field is
  // the authoritative element count, matching every other materialized vec in
  // the codebase. When true, array.len(data) == len as well.
  fctx.body.push({ op: "local.get", index: lenLocal });
  fctx.body.push({ op: "local.get", index: dataLocal });
  fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
}
