// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#684) Usage-based type inference for `any` / `unknown`-typed local variables.
 *
 * When TypeScript infers `any` (pervasive in untyped JS — the whole test262
 * corpus), codegen falls back to a boxed carrier (`externref` in host mode,
 * `$AnyValue` in fast mode). Every arithmetic read then pays a
 * `__box_number` / `__unbox_number` round-trip. This pre-pass narrows such a
 * local to an unboxed **f64** slot when — and ONLY when — doing so is
 * observationally sound.
 *
 * ## Soundness argument
 *
 * `__unbox_number` is exactly JS `Number()` (ToNumber). So storing the local
 * as f64 means every write coerces its source via `Number(source)`. This is
 * observationally equivalent to keeping the original value **iff every USE of
 * the variable already applies ToNumber to it** — i.e. the use is
 * *ToNumber-invariant*:
 *
 *   - operand of a strictly-numeric operator (`* / % - ** << >> >>> & | ^`,
 *     unary `- + ~`, `++`/`--`, and the matching compound assignments) —
 *     these coerce their operands with ToNumber unconditionally;
 *   - operand of a relational (`< > <= >=`) *where the other operand is
 *     statically numeric* — then the comparison is numeric (ToNumber-applying);
 *   - the assignment **target** `x = …` (a pure write).
 *
 * `+` / `+=` are deliberately EXCLUDED: they dispatch on the runtime type of
 * the operand, so `x + 3` is string *concatenation* (`"5" + 3 === "53"`) when
 * `x` is a string — narrowing to f64 would wrongly compute `8`. A static
 * number-hint on the other operand does not help (the ambiguity is in `x`).
 *
 * Anything that could observe the *original* (non-numeric) value — a property
 * read, an index, a call, an argument, `return x`, `===`/`==`, `+`/`+=`,
 * `typeof`, template interpolation, truthiness (`if (x)`, `!x`, `x && y`),
 * assignment to another binding, or capture by a nested closure — is NOT
 * ToNumber-invariant
 * and forces a bail (the local keeps its boxed carrier). The classifier
 * **defaults to bail** for every unrecognized context, so unsoundness requires
 * a positively-recognized safe use, never an omission.
 *
 * We further require at least one *evidence* use (a genuine arithmetic op, not
 * merely a write/comparison) before narrowing, so a variable that is only ever
 * assigned is left alone (no benefit, needless perturbation).
 *
 * ## Scope (this slice)
 *
 * Function-local `let` / `const` / `var` identifier bindings only. Parameters
 * (ABI-affecting, needs a call graph — deferred to #743), destructuring
 * bindings, for-of / for-in loop bindings, module globals, and
 * closure-captured locals are all out of scope (they return `undefined`).
 *
 * This module lives in the checker layer and may use the raw `ts.TypeChecker`
 * freely (the oracle-ratchet gate only scopes `src/codegen/**`). Codegen reads
 * the result through `ctx.usageInference` (see `create-context.ts`), so no
 * direct-checker debt is added to the backend.
 */
import { ts } from "../ts-api.js";

/** The concrete scalar a boxed-`any` local can be narrowed to. Room to grow
 *  (e.g. `"boolean"` / `"i32"`) without changing the call sites. */
export type InferredScalar = "number";

type FunctionLikeWithBody = ts.FunctionLikeDeclaration & { body: ts.Block | ts.ConciseBody };

/** Per-use classification. `bail` poisons the whole variable. */
type UseClass = "safe-evidence" | "safe" | "bail";

/**
 * (#3765) "Does a reference to `name` at `node` resolve to a slot whose every
 * DEFINITION is provably a number?" — the whole-program fixpoint's verdict,
 * supplied by `analyzeNumericPropertyNames`. See {@link UsageInference}.
 */
export type NumericLocalOracle = (node: ts.Node, name: string) => boolean;

/**
 * (#4121) "Is codegen about to widen this binding's slot to a boxed carrier,
 * even though the checker declared a scalar type?"
 *
 * The admission gate below keys on the CHECKER's declared type, but the slot
 * codegen mints is decided elsewhere: `let i = 0` is declared `number` while a
 * later `i = s.indexOf(";")` (unresolvable receiver) widens the slot to
 * `externref`. The declared type and the emitted representation then disagree,
 * and the pass whose whole job is to reconcile them never sees the binding.
 * This oracle lets codegen say which bindings it is about to widen, so
 * admission keys on the representation rather than the declaration.
 *
 * It only ADMITS a candidate. Both proofs (route 1 use-site, route 2
 * definition-site) then run unchanged and still have to earn the f64 slot.
 */
export type WidenedCarrierOracle = (decl: ts.VariableDeclaration) => boolean;

export class UsageInference {
  private declCache = new WeakMap<ts.VariableDeclaration, InferredScalar | null>();
  private fnCache = new WeakMap<ts.Node, Set<ts.Symbol>>();
  private numericLocals: NumericLocalOracle | undefined;
  private widenedCarrier: WidenedCarrierOracle | undefined;

  constructor(private readonly checker: ts.TypeChecker) {}

  /**
   * (#4121) Install the "codegen is about to box this slot" predicate. Called
   * once, before any function body compiles; clears the memo caches so an early
   * query cannot pin a pre-oracle verdict (same contract as
   * {@link setNumericLocalOracle}).
   */
  setWidenedCarrierOracle(oracle: WidenedCarrierOracle): void {
    this.widenedCarrier = oracle;
    this.declCache = new WeakMap();
    this.fnCache = new WeakMap();
  }

  /**
   * (#3765) Install the whole-program DEFINITION-site verdict as a second,
   * independent admission route.
   *
   * The two routes prove the same conclusion — "an f64 slot is observationally
   * equivalent here" — from opposite ends:
   *
   *  - the **use-site** route (#684, above) proves it because every USE already
   *    applies ToNumber, which says nothing about what the variable holds;
   *  - the **definition-site** route proves it because every DEFINITION is
   *    already a number, which makes every use safe *whatever it is*.
   *
   * So the def-site route lifts the use restrictions wholesale: `return c`,
   * `f(c)`, `c === x`, `typeof c` and `x + c` — every one of them a hard bail
   * for #684 — are all fine once the value is known to be a number. That is
   * the entire point: the tokenizer's `var c = s.charCodeAt(i); …; return c`
   * is rejected by #684 on the `return` alone.
   *
   * The three admission facts that stay REQUIRED are the ones the def-site
   * proof does not speak to: the binding must not be captured by a nested
   * closure (a capture lives in a ref cell, not a wasm local), must not be read
   * before its declaration (an f64 slot reads 0/NaN where JS says `undefined` —
   * the fixpoint proves what every WRITE holds, not that a write has happened
   * yet), and must not be bigint.
   *
   * Called once, before any function body compiles; clears the memo caches so
   * an early query cannot pin a pre-oracle verdict.
   */
  setNumericLocalOracle(oracle: NumericLocalOracle): void {
    this.numericLocals = oracle;
    this.declCache = new WeakMap();
    this.fnCache = new WeakMap();
  }

  /**
   * The scalar a boxed-`any` local should be narrowed to, or `undefined` when
   * the declaration is out of scope or narrowing would be unsound. Memoized
   * per declaration node. Never throws (any internal failure ⇒ `undefined`).
   */
  scalarForDecl(decl: ts.VariableDeclaration): InferredScalar | undefined {
    const cached = this.declCache.get(decl);
    if (cached !== undefined) return cached ?? undefined;
    let result: InferredScalar | null = null;
    try {
      result = this.compute(decl);
    } catch {
      result = null;
    }
    this.declCache.set(decl, result);
    return result ?? undefined;
  }

  private compute(decl: ts.VariableDeclaration): InferredScalar | null {
    if (!ts.isIdentifier(decl.name)) return null;
    // For-of / for-in loop bindings receive their value from iteration; the
    // codegen binding path differs — out of scope.
    const list = decl.parent;
    if (list && ts.isVariableDeclarationList(list)) {
      const stmt = list.parent;
      if (stmt && (ts.isForOfStatement(stmt) || ts.isForInStatement(stmt))) return null;
    }
    const fn = enclosingFunctionWithBody(decl);
    if (!fn) return null;
    const sym = this.checker.getSymbolAtLocation(decl.name);
    if (!sym) return null;
    const safe = this.analyzeFunction(fn);
    return safe.has(sym) ? "number" : null;
  }

  /**
   * Set of symbols in `fn` (declared as function-local any/unknown identifier
   * bindings) that are safe to narrow to f64. Memoized per function node.
   */
  private analyzeFunction(fn: FunctionLikeWithBody): Set<ts.Symbol> {
    const cached = this.fnCache.get(fn);
    if (cached) return cached;
    const result = new Set<ts.Symbol>();
    try {
      analyzeFunctionBody(this.checker, fn, result, this.numericLocals, this.widenedCarrier);
    } catch {
      result.clear();
    }
    this.fnCache.set(fn, result);
    return result;
  }
}

/**
 * Core analysis. Split out as a free function so a single `try/catch` in
 * `analyzeFunction` guards it. Populates `out` with the narrow-safe symbols.
 */
function analyzeFunctionBody(
  checker: ts.TypeChecker,
  fn: FunctionLikeWithBody,
  out: Set<ts.Symbol>,
  numericLocals?: NumericLocalOracle,
  widenedCarrier?: WidenedCarrierOracle,
): void {
  // 1. Collect candidate symbols: function-local any/unknown identifier
  //    bindings (not for-of/in).
  /**
   * `bailed` blocks only the #684 use-site route (some use is not
   * ToNumber-invariant). `poisoned` blocks BOTH routes — it records the facts
   * neither proof speaks to: capture by a nested closure, a read positioned
   * before the declaration, and a bigint initializer.
   */
  const candidates = new Map<
    ts.Symbol,
    { sawEvidence: boolean; bailed: boolean; poisoned: boolean; decl: ts.VariableDeclaration; declEnd: number }
  >();

  const collectCandidate = (decl: ts.VariableDeclaration): void => {
    if (!ts.isIdentifier(decl.name)) return;
    const list = decl.parent;
    let isLetConst = false;
    if (list && ts.isVariableDeclarationList(list)) {
      const stmt = list.parent;
      if (stmt && (ts.isForOfStatement(stmt) || ts.isForInStatement(stmt))) return;
      isLetConst = (list.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) !== 0;
    }
    // A `let`/`const` WITHOUT an initializer holds `undefined` after its decl
    // line (`ToNumber(undefined) === NaN`), but an f64 slot defaults to 0 and
    // there is no entry-init hook to seed NaN (unlike a hoisted `var`, which the
    // var-hoister NaN-inits). Out of scope — bail to keep the boxed carrier.
    if (isLetConst && !decl.initializer) return;
    const t = checker.getTypeAtLocation(decl);
    // (#4121) Admission keys on the REPRESENTATION codegen is about to emit,
    // not on the checker's declared type. A declared-`any` binding is boxed by
    // definition and always a candidate; a declared-scalar binding is one only
    // when codegen says it is widening that slot to a boxed carrier anyway
    // (`let i = 0; i = s.indexOf(";")` — declared `number`, slot `externref`).
    // Admission proves nothing on its own: both routes still run below.
    const declaredBoxed = t !== undefined && (t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
    if (!declaredBoxed && widenedCarrier?.(decl) !== true) return;
    const sym = checker.getSymbolAtLocation(decl.name);
    if (!sym) return;
    const state = candidates.get(sym) ?? {
      sawEvidence: false,
      bailed: false,
      poisoned: false,
      decl,
      declEnd: decl.end,
    };
    // A `var` may be redeclared; a use is only safely-after-assignment if it
    // follows the LAST of them.
    if (decl.end > state.declEnd) state.declEnd = decl.end;
    // A statically-bigint initializer poisons the narrowing: bigint arithmetic
    // (`5n * 2n === 10n`) is NOT f64 arithmetic, and mixing an f64 slot with a
    // bigint operand traps. `let x: any = 5n; -x` (unary, no sibling to inspect)
    // is only caught here.
    if (decl.initializer && isStaticallyBigInt(checker, decl.initializer)) state.poisoned = true;
    candidates.set(sym, state);
  };

  // Candidate collection must precede use-classification (hoisted `var` used
  // before it is declared; mutually-referencing decls). Don't descend into
  // nested functions for collection — their locals are a different scope.
  const collectPass = (node: ts.Node): void => {
    if (node !== fn && isFunctionLike(node)) return;
    if (ts.isVariableDeclaration(node)) collectCandidate(node);
    node.forEachChild(collectPass);
  };
  fn.forEachChild(collectPass);

  if (candidates.size === 0) return;

  // 2. Walk once classifying every value-reference use. `nested` marks a
  //    descent into a nested function-like — a candidate used there is
  //    closure-captured and bails.
  const walk = (node: ts.Node, nested: boolean): void => {
    if (node !== fn && isFunctionLike(node)) {
      node.forEachChild((c) => walk(c, true));
      return;
    }
    if (ts.isIdentifier(node) && !isDeclarationNamePosition(node)) {
      const sym = checker.getSymbolAtLocation(node);
      const state = sym && candidates.get(sym);
      if (state) {
        if (nested) {
          state.poisoned = true; // captured by a nested closure — lives in a ref cell
        } else {
          // (#3765) A read positioned before the declaration's end sees the
          // slot's pre-assignment value. JS says `undefined`; an f64 local says
          // 0 (or NaN for a hoisted `var` the hoister seeds). Both proofs are
          // about what a WRITE stores, so neither covers a read that precedes
          // every write — `if (a) return c; var c = 1;` and the self-reading
          // `var c = c + 1` are the shapes. Position order catches the
          // backward-jump cases (a loop body reading `c` above its own `var c`)
          // too, since the read still lexically precedes the declaration.
          if (node.pos < state.declEnd) state.poisoned = true;
          const cls = classifyUse(checker, node);
          if (cls === "bail") state.bailed = true;
          else if (cls === "safe-evidence") state.sawEvidence = true;
        }
      }
    }
    node.forEachChild((c) => walk(c, nested));
  };
  fn.forEachChild((c) => walk(c, false));

  for (const [sym, state] of candidates) {
    if (state.poisoned) continue;
    // Route 1 (#684): every use is ToNumber-invariant, and at least one is real
    // arithmetic. Route 2 (#3765): every definition is provably a number, which
    // makes the uses irrelevant. Either alone suffices.
    const useSiteProven = !state.bailed && state.sawEvidence;
    const defSiteProven =
      ts.isIdentifier(state.decl.name) && numericLocals?.(state.decl.name, state.decl.name.text) === true;
    if (useSiteProven || defSiteProven) out.add(sym);
  }
}

/** True when `id` is the *name* of a declaration (a binding position) or a
 *  member name, not a value reference. */
function isDeclarationNamePosition(id: ts.Identifier): boolean {
  const p = id.parent;
  if (!p) return false;
  if (ts.isVariableDeclaration(p) && p.name === id) return true;
  if (ts.isParameter(p) && p.name === id) return true;
  if (ts.isBindingElement(p) && p.name === id) return true;
  if (ts.isFunctionDeclaration(p) && p.name === id) return true;
  if (ts.isPropertyAccessExpression(p) && p.name === id) return true; // member name
  if (ts.isPropertyAssignment(p) && p.name === id) return true;
  if (ts.isShorthandPropertyAssignment(p) && p.name === id) return true;
  return false;
}

/**
 * Classify a single value-reference use of a candidate variable. The default
 * is `bail`: only positively-recognized ToNumber-invariant contexts are safe.
 */
function classifyUse(checker: ts.TypeChecker, id: ts.Identifier): UseClass {
  // Climb through runtime-transparent wrappers (parentheses / type-only casts).
  let node: ts.Expression = id;
  let parent = node.parent;
  while (
    parent &&
    (ts.isParenthesizedExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isTypeAssertionExpression(parent) ||
      ts.isNonNullExpression(parent) ||
      ts.isSatisfiesExpression(parent)) &&
    (parent as unknown as { expression: ts.Expression }).expression === node
  ) {
    node = parent as ts.Expression;
    parent = node.parent;
  }
  if (!parent) return "bail";

  // Binary expressions.
  if (ts.isBinaryExpression(parent)) {
    const isLeft = parent.left === node;
    const other = isLeft ? parent.right : parent.left;
    const op = parent.operatorToken.kind;
    switch (op) {
      // Strictly-numeric arithmetic / bitwise — always ToNumber both operands.
      case ts.SyntaxKind.AsteriskToken:
      case ts.SyntaxKind.SlashToken:
      case ts.SyntaxKind.PercentToken:
      case ts.SyntaxKind.MinusToken:
      case ts.SyntaxKind.AsteriskAsteriskToken:
      case ts.SyntaxKind.LessThanLessThanToken:
      case ts.SyntaxKind.GreaterThanGreaterThanToken:
      case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken:
      case ts.SyntaxKind.AmpersandToken:
      case ts.SyntaxKind.BarToken:
      case ts.SyntaxKind.CaretToken:
        // A bigint sibling means bigint arithmetic (`x * 2n`), not f64 — bail.
        return isStaticallyBigInt(checker, other) ? "bail" : "safe-evidence";
      // Compound numeric assignment (`x *= e`, `y &= x`, …). Both positions
      // ToNumber their operands.
      case ts.SyntaxKind.AsteriskEqualsToken:
      case ts.SyntaxKind.SlashEqualsToken:
      case ts.SyntaxKind.PercentEqualsToken:
      case ts.SyntaxKind.MinusEqualsToken:
      case ts.SyntaxKind.AsteriskAsteriskEqualsToken:
      case ts.SyntaxKind.LessThanLessThanEqualsToken:
      case ts.SyntaxKind.GreaterThanGreaterThanEqualsToken:
      case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken:
      case ts.SyntaxKind.AmpersandEqualsToken:
      case ts.SyntaxKind.BarEqualsToken:
      case ts.SyntaxKind.CaretEqualsToken:
        return isStaticallyBigInt(checker, other) ? "bail" : "safe-evidence";
      // `+` / `+=` are NOT ToNumber-invariant for an `any` operand — if the
      // value is a string at runtime, `x + 3` is string *concatenation*
      // (`"5" + 3 === "53"`), NOT numeric addition, even when the other operand
      // is statically numeric. A number-hint is insufficient because `+`
      // dispatches on the RUNTIME type of `x`, which we do not know. Always bail
      // (a string-typed `x` narrowed to f64 would compute `5 + 3 === 8`).
      // Relational: numeric comparison when the other operand is statically
      // numeric (ToNumber-invariant), but weak evidence on its own.
      case ts.SyntaxKind.LessThanToken:
      case ts.SyntaxKind.GreaterThanToken:
      case ts.SyntaxKind.LessThanEqualsToken:
      case ts.SyntaxKind.GreaterThanEqualsToken:
        return isStaticallyNumeric(checker, other) ? "safe" : "bail";
      // Plain assignment: safe ONLY as the write target (`x = …`); as a source
      // (`y = x`) the value escapes → bail. A bigint RHS poisons the slot.
      case ts.SyntaxKind.EqualsToken:
        return isLeft ? (isStaticallyBigInt(checker, other) ? "bail" : "safe") : "bail";
      default:
        return "bail"; // ===, ==, &&, ||, ??, in, instanceof, comma, …
    }
  }

  // Prefix unary: -x, +x, ~x, ++x, --x are numeric; !x is truthiness → bail.
  if (ts.isPrefixUnaryExpression(parent) && parent.operand === node) {
    switch (parent.operator) {
      case ts.SyntaxKind.MinusToken:
      case ts.SyntaxKind.PlusToken:
      case ts.SyntaxKind.TildeToken:
      case ts.SyntaxKind.PlusPlusToken:
      case ts.SyntaxKind.MinusMinusToken:
        return "safe-evidence";
      default:
        return "bail";
    }
  }

  // Postfix x++ / x-- are numeric read-modify-write.
  if (ts.isPostfixUnaryExpression(parent) && parent.operand === node) {
    return "safe-evidence";
  }

  return "bail";
}

/** Statically-numeric = the checker type is `number` / a number literal, and
 *  NOT `any`/`unknown` (which would make `+` ambiguous). */
function isStaticallyNumeric(checker: ts.TypeChecker, expr: ts.Expression): boolean {
  let t: ts.Type | undefined;
  try {
    t = checker.getTypeAtLocation(expr);
  } catch {
    return false;
  }
  if (!t) return false;
  if (t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return false;
  return (t.flags & (ts.TypeFlags.Number | ts.TypeFlags.NumberLiteral)) !== 0;
}

/** Statically-bigint = the checker type is `bigint` / a bigint literal. Such an
 *  operand makes the surrounding op bigint arithmetic, which an f64 slot cannot
 *  represent — so it poisons narrowing. */
function isStaticallyBigInt(checker: ts.TypeChecker, expr: ts.Expression): boolean {
  let t: ts.Type | undefined;
  try {
    t = checker.getTypeAtLocation(expr);
  } catch {
    return false;
  }
  if (!t) return false;
  return (t.flags & (ts.TypeFlags.BigInt | ts.TypeFlags.BigIntLiteral)) !== 0;
}

function isFunctionLike(node: ts.Node): node is FunctionLikeWithBody {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

/** Nearest enclosing function-like WITH a body, or `undefined` at module scope. */
function enclosingFunctionWithBody(node: ts.Node): FunctionLikeWithBody | undefined {
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (isFunctionLike(cur) && (cur as FunctionLikeWithBody).body) return cur as FunctionLikeWithBody;
    if (ts.isSourceFile(cur)) return undefined;
    cur = cur.parent;
  }
  return undefined;
}
