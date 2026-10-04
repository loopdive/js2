// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6772 S1b) The derived-constructor uninitialised-`this` guard — §9.1.1.3.4
 * GetThisBinding / §9.1.1.3.1 BindThisValue for a DERIVED constructor.
 *
 * #5350 (r2..r5) built the classification and the `__js2_super_done` runtime
 * flag for `super.<x>` READS and WRITES; they moved here verbatim from
 * `expressions/new-super.ts` and are generalised to every node that performs
 * GetThisBinding in a derived constructor:
 *
 *   - a `this` keyword (`this-keyword.ts`, and the `this.x = v` / `this[k] = v`
 *     assignment arms, which take their receiver without `compileThisKeyword`);
 *   - a `super.m()` CALLEE (`compileSuperMethodCall`), whose lowering had no
 *     guard at all;
 *   - a SECOND `super(...)`: BindThisValue on an initialised binding is a
 *     ReferenceError, raised AFTER the parent constructor ran (§13.3.7.1 step 6
 *     precedes step 8) — `emitSuperCallBindThis`.
 *
 * Standalone only; everything is a no-op outside a derived constructor.
 */
import { forEachChild, ts } from "../../ts-api.js";
import { allocLocal } from "../context/locals.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { buildThrowJsErrorInstrs } from "../helpers/core-delegates.js"; // (#6797) keeps this leaf out of the codegen SCC
import { resolveEnclosingClassName, skipTransparentExpressions } from "../shared.js";

const UNINITIALIZED_THIS_MESSAGE =
  "Must call super constructor in derived class before accessing 'this' or returning from derived constructor";

/**
 * (#5350 step 4b) In a DERIVED constructor, is this `super.<x>` read provably
 * evaluated while `this` is still uninitialised?
 *
 * §13.3.7.1 resolves a SuperProperty by calling `GetThisBinding()` FIRST, and
 * in a derived constructor that binding stays uninitialised until `super(...)`
 * returns — so the read is a ReferenceError. Proving it needs only a LEXICAL
 * check, kept deliberately conservative in the safe direction: the answer is
 * `true` only when the enclosing constructor contains NO `super(...)` call that
 * ends before this reference begins. A `super()` anywhere earlier — including
 * inside an `if` or a loop, where it may not actually have run — keeps today's
 * behaviour rather than risking a throw in a working program.
 *
 * A reference inside a nested function or arrow is excluded outright: its
 * source position says nothing about when it runs (`() => super.x` written
 * before `super()` and called after it is correct code), and an arrow is
 * compiled into the constructor's own FunctionContext, so `isDerivedConstructor`
 * alone cannot tell them apart.
 */
type UninitializedThisKind = "always" | "runtime" | "never";

/**
 * Does `root` contain a `super(...)` call, optionally only one that ends
 * before `endsBefore`?
 *
 * `skipNestedClasses` excludes a NESTED class's own `super()`: it initialises
 * THAT class's `this`, never the enclosing constructor's, so counting it as a
 * back-edge carrier wrongly suppressed the throw for
 * `for (…) { class C extends A { constructor(){ super() } }; v = super.zz }`
 * (probe xa11 — node throws, this answered 6). It is set for BOTH the
 * "completes textually before the read" scan and the enclosing-loop scan, for
 * the same reason in both: that `super()` belongs to another constructor.
 * `skipNestedFunctions` excludes a `super()` written inside a nested FUNCTION
 * (arrow, function expression/declaration). Such a call still initialises THIS
 * constructor's `this` — `const f = () => super(); f();` really does — so the
 * "completes textually before the read" scan leaves it OFF and keeps counting
 * it. The enclosing-loop scan turns it ON (#5350 r4), because that scan decides
 * whether a runtime flag can be TRUSTED, and the flag is a wasm LOCAL of the
 * constructor: a nested function compiles to a separate wasm function whose
 * `FunctionContext` has no such local, so `emitSuperInitializedFlagStore` there
 * is a no-op and the flag would stay 0 for ever (probe s1c2).
 */
function containsSuperCall(
  root: ts.Node,
  endsBefore: number | undefined,
  skipNestedClasses: boolean,
  skipNestedFunctions = false,
): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    // (#6772 S1b) Nothing that STARTS at/after `endsBefore` can end before it —
    // prune, so a constructor with many `this` uses stays linear per use.
    if (endsBefore !== undefined && node.pos >= endsBefore) return;
    if (skipNestedClasses && (ts.isClassDeclaration(node) || ts.isClassExpression(node))) return;
    if (
      skipNestedFunctions &&
      (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node))
    ) {
      return;
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.SuperKeyword &&
      (endsBefore === undefined || node.end <= endsBefore)
    ) {
      found = true;
      return;
    }
    forEachChild(node, visit);
  };
  forEachChild(root, visit);
  return found;
}

/**
 * (#5350 r3 review, S1) Classify a `super.<x>` read in a DERIVED constructor.
 *
 *   - `"always"`  — no `super(...)` completes before the read and no enclosing
 *     loop can carry one back over it: an unconditional ReferenceError.
 *   - `"runtime"` — the read sits inside a loop that ALSO contains a
 *     `super(...)`. Position cannot decide this case, in either direction:
 *     `for (let i = 0; i < 1; i++) { v = super.zz; super() }` reaches the read
 *     on iteration 1 before any `super()` has run (node throws — probes
 *     xa13/xa12/xa3), while `while (true) { if (i === 1) { v = super.zz; break }
 *     super(); i = 1 }` reaches the SAME textual read on iteration 2 with
 *     `this` long initialised (node answers 5 — probes n4/n5). Both shapes are
 *     "a read textually before a `super()` in the same loop", so the decision
 *     moves to a runtime test of `fctx.superInitializedFlagLocal`. r2's
 *     position-blind rule answered "no throw" for the whole class and so lost
 *     the iteration-1 case.
 *   - `"never"`   — a `super(...)` completes textually before the read, or the
 *     reference crosses a nested function/class boundary whose source position
 *     says nothing about when it runs (`() => super.x` written before
 *     `super()` and called after it is correct code). Keep the ordinary read.
 */
function classifyUninitializedThisAccess(fctx: FunctionContext, expr: ts.Node): UninitializedThisKind {
  if (!fctx.isDerivedConstructor) return "never";
  // (#5350 r2 review, R1) NO BACK-EDGE THAT CAN CARRY A `super()` OVER THE
  // READ. Source position orders the TEXT, not the execution, and the one
  // construct that lets a textually LATER `super()` run BEFORE this read is a
  // loop's back-edge — but only when that `super()` is INSIDE the same loop:
  // `while (true) { if (i === 1) { v = super.zz; break } super(); i = 1 }`
  // reaches the read on the second iteration with `this` long initialised
  // (node answers 5, probes n4/n5). A loop that contains NO `super()` has no
  // such edge, so `for (let i = 0; i < 1; i++) { v = super.zz } super()` is
  // still an unconditional ReferenceError (probes d02b/d10) — r1 suppressed
  // those too, by returning false for ANY enclosing iteration statement.
  // Labelled statements are not a case at all: a labelled BLOCK is
  // forward-only (`break lbl` jumps out, never back — probe d01b), and a
  // labelled LOOP is an iteration statement already, caught below.
  // Forward-only branches (`if` / `switch` / `try`) cannot re-run an earlier
  // `super()`, and a `super()` in a branch textually BEFORE the read is
  // handled by the preceded-by check. Anything suppressed here falls through
  // to the ordinary read, which answers `undefined` rather than inventing a
  // throw. The compiler cannot be more precise without a runtime
  // this-initialised flag: a derived constructor's `this` local is
  // `struct.new`-allocated at entry (class-bodies.ts), so there is no null to
  // test at the read.
  const enclosingLoops: ts.IterationStatement[] = [];
  let current: ts.Node | undefined = expr.parent;
  while (current && !ts.isConstructorDeclaration(current)) {
    if (ts.isIterationStatement(current, /* lookInLabeledStatements */ false)) {
      enclosingLoops.push(current);
    }
    if (
      ts.isArrowFunction(current) ||
      ts.isFunctionExpression(current) ||
      ts.isFunctionDeclaration(current) ||
      ts.isMethodDeclaration(current) ||
      ts.isGetAccessorDeclaration(current) ||
      ts.isSetAccessorDeclaration(current) ||
      ts.isClassDeclaration(current) ||
      ts.isClassExpression(current) ||
      ts.isObjectLiteralExpression(current)
    ) {
      return "never";
    }
    current = current.parent;
  }
  if (!current?.body) return "never";
  // (a) no `super(...)` completes textually before the read begins …
  if (containsSuperCall(current.body, expr.pos, /* skipNestedClasses */ true)) return "never";
  // (b) … and where an enclosing loop could bring a later one back over it,
  // only a runtime flag can say whether it already did.
  // (#5350 r4 review) The carrier must be one this compiler can INSTRUMENT.
  // The flag is a wasm local of the constructor, so only a `super(...)`
  // lexically in the constructor's own body can store into it; a `super()`
  // inside a nested function is lowered in that function's own
  // `FunctionContext`, where the store is a no-op. Classifying such a read
  // "runtime" therefore allocated a flag nothing ever set and threw on every
  // iteration (probe s1c2 — node 6, r3 9). A loop whose only carrier sits in a
  // nested function is left UNGUARDED instead ("never" — the ordinary read,
  // which is round-2 and base behaviour): still wrong for a read that really is
  // reached before the arrow's `super()` runs, but wrong in the direction that
  // answers `undefined` rather than inventing a throw.
  // (#5350 r5 review) … and the flag is trustworthy only when EVERY carrier
  // an enclosing loop holds can store into it. A loop with a constructor-body
  // `super()` AND a nested-function `super()` (probe e15: `if (useArrow) { const
  // f = () => { super() }; f() } else { super() }`) took the "runtime" arm on
  // the strength of the body carrier, but on the path that ran the arrow's
  // call the flag stayed 0 and the read threw on an initialised `this` (node 6,
  // r4 9). One untrustworthy carrier anywhere in the enclosing loops therefore
  // leaves the read UNGUARDED, whatever else the loop contains.
  let guardableCarrier = false;
  let untrustedCarrier = false;
  for (const loop of enclosingLoops) {
    if (containsSuperCallInNestedFunction(loop)) untrustedCarrier = true;
    if (containsSuperCall(loop, undefined, /* skipNestedClasses */ true, /* skipNestedFunctions */ true)) {
      guardableCarrier = true;
    }
  }
  if (untrustedCarrier) return "never";
  if (guardableCarrier) return "runtime";
  return "always";
}

/**
 * (#5350 r5 review) True when `root` holds a `super(...)` INSIDE a nested
 * function (arrow / function expression / function declaration), i.e. a
 * carrier that initialises this constructor's `this` but whose store to the
 * `__super_done` flag cannot land (it is lowered in the nested function's own
 * `FunctionContext`). Nested classes are skipped: their `super()` belongs to
 * another constructor.
 */
function containsSuperCallInNestedFunction(root: ts.Node): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) return;
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node)) {
      if (containsSuperCall(node, undefined, /* skipNestedClasses */ true)) found = true;
      return;
    }
    forEachChild(node, visit);
  };
  forEachChild(root, visit);
  return found;
}

/**
 * (#5350 r3 review, S1; widened by #6772 S1b) Allocate the derived
 * constructor's `__js2_super_done` flag when some `super(...)` in the
 * constructor's OWN frame can be reached with `this` already initialised —
 * then that call must throw after the parent ran, and a `"runtime"`-classified
 * `this` / `super` reference needs the flag to decide. That is the case when
 * the frame holds MORE than one `super(...)` node (nested functions are
 * descended for the count, but their calls cannot store into this local — the
 * xa8-style residual), or a frame-level `super(...)` sits inside a loop (every
 * `"runtime"` reference implies one). A wasm local is zero at entry, so no
 * initialising store is needed.
 *
 * Must run BEFORE the constructor body is compiled: `emitSuperCallBindThis`
 * needs the index at every `super(...)` site, and a `super(...)` can be
 * compiled before the reference that motivates the flag.
 */
export function ensureSuperInitializedFlagLocal(
  ctx: CodegenContext,
  fctx: FunctionContext,
  ctor: ts.ConstructorDeclaration,
): void {
  if (!ctx.standalone) return;
  if (!fctx.isDerivedConstructor) return;
  if (fctx.superInitializedFlagLocal !== undefined) return;
  if (!ctor.body) return;
  let needed = false;
  let superCalls = 0;
  const visit = (node: ts.Node, inLoop: boolean, inFunction: boolean): void => {
    if (needed) return;
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) return;
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.SuperKeyword) {
      superCalls++;
      if (superCalls > 1 || (inLoop && !inFunction)) {
        needed = true;
        return;
      }
    }
    const loop = inLoop || ts.isIterationStatement(node, /* lookInLabeledStatements */ false);
    const fn = inFunction || ts.isFunctionLike(node);
    forEachChild(node, (child) => visit(child, loop, fn));
  };
  forEachChild(ctor.body, (child) => visit(child, false, false));
  if (!needed) return;
  fctx.superInitializedFlagLocal = allocLocal(fctx, "__js2_super_done", { kind: "i32" });
}

/**
 * (#5350 r3 review, S1) `this` is initialised from here on — store 1 into the
 * flag, immediately after a `super(...)` call's lowering returns. A no-op
 * unless this constructor allocated the flag, which is why a NESTED class's
 * `super()` (a different FunctionContext) can never set the outer one.
 */
export function emitSuperInitializedFlagStore(fctx: FunctionContext): void {
  const idx = fctx.superInitializedFlagLocal;
  if (idx === undefined) return;
  fctx.body.push({ op: "i32.const", value: 1 });
  fctx.body.push({ op: "local.set", index: idx });
}

/**
 * (#6772 S1b) §13.3.7.1 steps 6-8 at a `super(...)` whose lowering just
 * returned (the parent constructor HAS run): BindThisValue on an
 * already-initialised binding is a ReferenceError; otherwise `this` is
 * initialised from here on. Without the flag (a single straight-line
 * `super()`) this emits nothing, exactly as the #5350 store did.
 *
 * `beforeThrow` runs inside the throw arm (the S2 return-override restore).
 */
export function emitSuperCallBindThis(ctx: CodegenContext, fctx: FunctionContext, beforeThrow?: () => void): void {
  const idx = fctx.superInitializedFlagLocal;
  if (idx === undefined) return;
  fctx.body.push({ op: "local.get", index: idx });
  const start = fctx.body.length;
  beforeThrow?.();
  emitThrowReferenceError(ctx, fctx, "Super constructor may only be called once");
  const throwInstrs = fctx.body.splice(start);
  fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: throwInstrs, else: [] });
  fctx.body.push({ op: "i32.const", value: 1 });
  fctx.body.push({ op: "local.set", index: idx });
}

/**
 * (#5350 step 4b) §13.3.7.1 GetThisBinding for a `super` reference in a derived
 * constructor — shared by the READ and (#5350 r2) the WRITE, since §13.15.2
 * evaluates the SuperProperty reference, and so GetThisBinding, before the RHS.
 * `"runtime"` emits the flag test and returns `false` (fall through to the
 * ordinary lowering); `"always"` emits the unconditional ReferenceError and
 * returns `true` — nothing is left on the stack, the caller stops.
 */
export function emitSuperUninitializedThisCheck(ctx: CodegenContext, fctx: FunctionContext, expr: ts.Node): boolean {
  if (!ctx.standalone) return false;
  const kind = classifyUninitializedThisAccess(fctx, expr);
  if (kind === "never") return false;
  const message = UNINITIALIZED_THIS_MESSAGE;
  if (kind === "runtime") {
    // (#5350 r3 review, S1) `if (__super_done === 0) throw` — and then fall
    // through to the ordinary read, which is correct on every iteration where
    // the flag is set. Returning `false` when the flag was not allocated
    // keeps r2's behaviour rather than inventing a throw.
    const flagLocal = fctx.superInitializedFlagLocal;
    if (flagLocal === undefined) return false;
    fctx.body.push({ op: "local.get", index: flagLocal });
    fctx.body.push({ op: "i32.eqz" });
    const start = fctx.body.length;
    emitThrowReferenceError(ctx, fctx, message);
    const throwInstrs = fctx.body.splice(start);
    fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: throwInstrs, else: [] });
    return false;
  }
  emitThrowReferenceError(ctx, fctx, message);
  return true;
}

/**
 * (#6772 S1b) GetThisBinding guard for a `this` keyword or a `super.m()`
 * callee in a derived constructor. `"always"` emits the ReferenceError and the
 * caller FALLS THROUGH to its ordinary lowering (dead, but well-typed), so no
 * call site has to fabricate a result; `"runtime"` tests the flag.
 */
export function emitUninitializedThisGuard(ctx: CodegenContext, fctx: FunctionContext, node: ts.Node): void {
  if (!ctx.standalone || !fctx.isDerivedConstructor) return;
  emitSuperUninitializedThisCheck(ctx, fctx, node);
}

/**
 * (#6772 S1b) `this.x = v` / `this[k] = v`: the assignment arms take a `this`
 * receiver without `compileThisKeyword` (typed-this field set, pinned struct
 * set), so GetThisBinding is guarded once at their entry — before the RHS.
 */
export function guardThisReceiver(ctx: CodegenContext, fctx: FunctionContext, receiver: ts.Expression): void {
  if (!ctx.standalone || !fctx.isDerivedConstructor) return;
  const node = skipTransparentExpressions(receiver);
  if (node.kind !== ts.SyntaxKind.ThisKeyword) return;
  emitSuperUninitializedThisCheck(ctx, fctx, node);
}

/**
 * (#6772 S1b) The class whose constructor `fctx` is compiling, for a NESTED
 * `super(...)`. `resolveEnclosingClassName` cuts the `<C>_init` display name at
 * the FIRST underscore, which loses a synthetic `__anonClass_C_N` (two
 * same-named block-scoped classes) or any `My_Class` — the nested `super()`
 * then lowered to nothing and the parent never ran. Strip the known suffix and
 * confirm it names a class first.
 */
export function constructorFrameClassName(ctx: CodegenContext, fctx: FunctionContext): string | undefined {
  if (ctx.standalone && !fctx.enclosingClassName) {
    for (const suffix of ["_init", "_new"]) {
      if (!fctx.name.endsWith(suffix)) continue;
      const name = fctx.name.slice(0, -suffix.length);
      if (ctx.classSet.has(name)) return name;
    }
  }
  return resolveEnclosingClassName(fctx);
}

/** `emitThrowReferenceError` (js-errors.ts) through the core delegates. */
function emitThrowReferenceError(ctx: CodegenContext, fctx: FunctionContext, message: string): void {
  fctx.body.push(...buildThrowJsErrorInstrs(ctx, "ReferenceError", message, { flush: fctx }));
}
