// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#743) The satellite's LOCAL-BINDING rule — the lever the 2026-08-07 Results
// section ranked #2 and the 2026-08-08 pin census made load-bearing: acorn's
// `this.pos += size` (:5798) pins `Parser.pos` because `size` is fed by LOCALS
// (`var size = 1; ++size; size = cond ? 3 : 2`) at every `finishOp` call site,
// and the satellite's scope model was params-only. Likewise `this.pos = end + 2`
// (:5494) reads the local `end`.
//
// Model: a local's lattice value is the JOIN of every contribution that can
// ever be stored in it — the same flow-INsensitive, widen-only direction the
// whole family uses. Loops need no handling at all: the join is order-free.
// Flow-sensitivity (last-write-wins) is deliberately rejected — unsound across
// loop back-edges without a CFG, and the measured stalls were never
// ordering-precision losses.
//
// A local is ELIGIBLE iff ALL of (the undefined-read guard, same hazard class
// as `readFieldFact`'s snapshot rule — an f64 fact for a read that can observe
// `undefined` turns it into NaN at a coercing store):
//
//  1. it has exactly ONE declaration, with an initializer, declared by a
//     `var`/`let`/`const` statement that is a DIRECT child of its declaring
//     function's body block. Direct-child is load-bearing and STRICTER than
//     the issue spec's position rule: `if (c) var x = 1; use(x)` satisfies
//     "initializer present + read after the declaration" yet still reads
//     `undefined` when `c` is false. A direct-child statement cannot be
//     skipped on the way to any later statement of the same block, so every
//     positionally-later occurrence executes after the initializer ran.
//     (Recorded spec deviation: the 2026-08-07 locals spec §3.1 claims rules
//     1+2 alone exclude undefined reads; conditionally-executed declarations
//     falsify that claim.)
//  2. no occurrence of the symbol sits positionally BEFORE the end of its
//     declaration, and none sits inside a nested FunctionDeclaration —
//     hoisting lets a textually-later fn-decl body run before the
//     initializer. (Function EXPRESSIONS and arrows are values: they cannot
//     be invoked before the code creating the closure ran, and that code
//     sits after the declaration or is itself excluded by position.)
//  3. it is not a parameter, not a destructuring/for-in/for-of/catch binding.
//  4. the declaring function's subtree contains no `with` and no direct
//     `eval` call — either can write a var-scoped local without leaving an
//     identifier occurrence for the scan to see.
//
// An INELIGIBLE local answers DYNAMIC explicitly (never `undefined`): the rule
// resolves by SYMBOL, so falling through would let `core.inferExpr`'s
// name-keyed scope hand back a same-named OUTER binding's fact (trap T6).
//
// Contributions mirror the FieldWrite taxonomy (`fnctor-field-writes.ts`):
// initializer / `x = rhs` → eval(rhs) (assignment-chain unwrapped) · numeric
// compounds and `++`/`--` → F64 (a Number regardless of the old value) ·
// `x += rhs` → the string-or-number plus join over the running join ·
// `x &&=`/`||=`/`??=` → eval(rhs) (the old value is already in the join).
// A contribution written inside a NESTED function-like contributes DYNAMIC:
// its RHS closes over bindings (the nested fn's own params/locals) that the
// read-site scope map cannot represent, and evaluating it there would resolve
// same-named identifiers to the WRONG binding. (Recorded spec deviation from
// §3.1, which wanted precise closure-write joins; on the measured corpus every
// pin-relevant local is closure-free, so the precision buys nothing here.)
//
// Cycles between locals (`var a = 1; var b = a; a = b;`) re-enter through the
// identifier rule; a per-evaluation visiting set answers lattice BOTTOM
// (`unknown`) on re-entry, which computes exactly the SCC's join — the values
// the re-entry stands for are already accounted at the outer join level.
//
// SATELLITE-ONLY, like every sibling rule: the always-on main-map path passes
// no extension, so #1712 flag-off byte-parity holds by construction.
import { forEachChild, ts } from "../ts-api.js";
import { isFunctionLikeNode, unwrap } from "./fnctor-graph-model.js";
import { _propagationCore as core, type InferExtension, type LatticeType } from "./propagate.js";

const F64: LatticeType = { kind: "f64" };
const STRING: LatticeType = { kind: "string" };

const NUMERIC_COMPOUND: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.AsteriskAsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.PercentEqualsToken,
  ts.SyntaxKind.LessThanLessThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.AmpersandEqualsToken,
  ts.SyntaxKind.BarEqualsToken,
  ts.SyntaxKind.CaretEqualsToken,
]);

const LOGICAL_COMPOUND: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
]);

interface Contribution {
  readonly kind: "eval" | "numeric" | "plus" | "logical";
  /** RHS as written; absent for `numeric`. */
  readonly expr?: ts.Expression;
  /** The write sits inside a function-like nested in the declaring function. */
  readonly nested: boolean;
}

interface LocalSpec {
  readonly eligible: boolean;
  readonly contributions: readonly Contribution[];
}

function enclosingFunctionOf(node: ts.Node): ts.SignatureDeclaration | undefined {
  for (let cur: ts.Node | undefined = node.parent; cur !== undefined; cur = cur.parent) {
    if (isFunctionLikeNode(cur)) return cur;
  }
  return undefined;
}

/** The declaring statement is a DIRECT child of the function's body block. */
function isDirectBodyStatement(decl: ts.VariableDeclaration, fn: ts.SignatureDeclaration): boolean {
  const list = decl.parent;
  if (!ts.isVariableDeclarationList(list)) return false;
  const stmt = list.parent;
  if (!ts.isVariableStatement(stmt)) return false; // for/for-in/for-of heads excluded here
  const body = (fn as { body?: ts.Node }).body;
  return body !== undefined && ts.isBlock(body) && stmt.parent === body;
}

/** `with` anywhere, or a direct `eval(...)` identifier call, in the subtree. */
const dynamicScopeCache = new WeakMap<ts.Node, boolean>();
function hasDynamicScope(root: ts.Node): boolean {
  const cached = dynamicScopeCache.get(root);
  if (cached !== undefined) return cached;
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isWithStatement(n)) found = true;
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "eval") found = true;
    forEachChild(n, visit);
  };
  visit(root);
  dynamicScopeCache.set(root, found);
  return found;
}

/** Inside a nested (relative to `fn`) hoisted FunctionDeclaration? */
function insideNestedFunctionDeclaration(node: ts.Node, fn: ts.SignatureDeclaration): boolean {
  for (let cur: ts.Node | undefined = node.parent; cur !== undefined && cur !== fn; cur = cur.parent) {
    if (ts.isFunctionDeclaration(cur)) return true;
  }
  return false;
}

function insideNestedFunctionLike(node: ts.Node, fn: ts.SignatureDeclaration): boolean {
  for (let cur: ts.Node | undefined = node.parent; cur !== undefined && cur !== fn; cur = cur.parent) {
    if (isFunctionLikeNode(cur)) return true;
  }
  return false;
}

/**
 * Same string-or-number `+` rule as the field lattice's `plusJoin`:
 * `undefined + 1` is NaN (a number), `undefined + "s"` is a string — both are
 * covered by the operand classes, so a pre-initialization `+=` (excluded by
 * eligibility anyway) could not break it either.
 */
function plusJoin(current: LatticeType, rhs: LatticeType): LatticeType {
  if (current.kind === "string" || rhs.kind === "string") return STRING;
  const numeric = (t: LatticeType): boolean =>
    t.kind === "f64" || t.kind === "i32" || t.kind === "u32" || t.kind === "unknown";
  return numeric(current) && numeric(rhs) ? F64 : core.DYNAMIC;
}

const INELIGIBLE: LocalSpec = { eligible: false, contributions: [] };

function buildLocalSpec(sym: ts.Symbol, checker: ts.TypeChecker): LocalSpec {
  const decls = sym.getDeclarations() ?? [];
  if (decls.length !== 1) return INELIGIBLE;
  const decl = decls[0]!;
  if (!ts.isVariableDeclaration(decl) || !ts.isIdentifier(decl.name)) return INELIGIBLE;
  if (decl.initializer === undefined) return INELIGIBLE;
  const fn = enclosingFunctionOf(decl);
  if (fn === undefined) return INELIGIBLE; // top-level bindings are fnctor-module-consts' turf
  if (!isDirectBodyStatement(decl, fn)) return INELIGIBLE;
  if (hasDynamicScope(fn)) return INELIGIBLE;

  const declEnd = decl.end;
  const contributions: Contribution[] = [{ kind: "eval", expr: decl.initializer, nested: false }];
  let eligible = true;
  const sameSymbol = (id: ts.Identifier): boolean =>
    id.text === (decl.name as ts.Identifier).text && checker.getSymbolAtLocation(id) === sym;

  const visit = (n: ts.Node): void => {
    if (!eligible) return;
    if (ts.isIdentifier(n) && n !== decl.name && sameSymbol(n)) {
      if (n.getStart() < declEnd || insideNestedFunctionDeclaration(n, fn)) {
        eligible = false;
        return;
      }
      const nested = insideNestedFunctionLike(n, fn);
      const parent = n.parent;
      if (parent !== undefined && ts.isBinaryExpression(parent) && parent.left === n) {
        const op = parent.operatorToken.kind;
        if (op === ts.SyntaxKind.EqualsToken) contributions.push({ kind: "eval", expr: parent.right, nested });
        else if (op === ts.SyntaxKind.PlusEqualsToken) contributions.push({ kind: "plus", expr: parent.right, nested });
        else if (NUMERIC_COMPOUND.has(op)) contributions.push({ kind: "numeric", nested });
        else if (LOGICAL_COMPOUND.has(op)) contributions.push({ kind: "logical", expr: parent.right, nested });
      } else if (
        parent !== undefined &&
        (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
        (parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken)
      ) {
        contributions.push({ kind: "numeric", nested });
      } else if (
        parent !== undefined &&
        (ts.isForInStatement(parent) || ts.isForOfStatement(parent)) &&
        parent.initializer === n
      ) {
        eligible = false; // arbitrary values from iteration — treat like a destructuring target
      } else if (parent !== undefined && ts.isShorthandPropertyAssignment(parent)) {
        // `({x} = o)` destructuring writes through the value symbol; a plain
        // shorthand in an object literal is a read. Distinguishing the two
        // needs the assignment-pattern context — refuse both, cheaply.
        eligible = false;
      } else if (parent !== undefined && (ts.isBindingElement(parent) || ts.isArrayLiteralExpression(parent))) {
        // Could be a destructuring assignment target (`[x] = a`); refusing the
        // array-literal position outright also covers the read case — a rare
        // over-refusal, never an unsoundness.
        eligible = false;
      }
    }
    forEachChild(n, visit);
  };
  const fnBody = (fn as { body?: ts.Node }).body;
  if (fnBody === undefined) return INELIGIBLE;
  visit(fnBody);
  return eligible ? { eligible: true, contributions } : INELIGIBLE;
}

/**
 * Build the rule. `evaluate` must recurse through the composed extension (the
 * standing nesting caveat on `createI32ProducerExtension`).
 */
export function createLocalBindingExtension(
  sf: ts.SourceFile,
  checker: ts.TypeChecker,
  evaluate: (expr: ts.Expression, scope: ReadonlyMap<string, LatticeType>) => LatticeType,
): InferExtension {
  // Cheap name pre-filter: only identifiers that are SOME function-local
  // `var`/`let`/`const` name anywhere in the file reach the checker.
  const localNames = new Set<string>();
  const collect = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && enclosingFunctionOf(n) !== undefined) {
      localNames.add(n.name.text);
    }
    forEachChild(n, collect);
  };
  forEachChild(sf, collect);
  if (localNames.size === 0) return { tryInfer: () => undefined };

  const specs = new Map<ts.Symbol, LocalSpec>();
  const specOf = (sym: ts.Symbol): LocalSpec => {
    const cached = specs.get(sym);
    if (cached) return cached;
    const spec = buildLocalSpec(sym, checker);
    specs.set(sym, spec);
    return spec;
  };

  /** Symbols on the current evaluation path — re-entry answers lattice BOTTOM. */
  const visiting = new Set<ts.Symbol>();

  return {
    tryInfer(expr, scope) {
      if (!ts.isIdentifier(expr) || !localNames.has(expr.text)) return undefined;
      const sym = checker.getSymbolAtLocation(expr);
      if (sym === undefined) return undefined;
      const decl = sym.valueDeclaration;
      if (decl === undefined || !ts.isVariableDeclaration(decl) || enclosingFunctionOf(decl) === undefined) {
        return undefined; // not a function-local — params / module bindings keep their own rules
      }
      const spec = specOf(sym);
      if (!spec.eligible) return core.DYNAMIC;
      if (visiting.has(sym)) return core.UNKNOWN;
      visiting.add(sym);
      try {
        let joined: LatticeType = core.UNKNOWN;
        for (const c of spec.contributions) {
          let contribution: LatticeType;
          if (c.nested) contribution = core.DYNAMIC;
          else if (c.kind === "numeric") contribution = F64;
          else {
            let rhs = unwrap(c.expr!);
            while (ts.isBinaryExpression(rhs) && rhs.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
              rhs = unwrap(rhs.right);
            }
            const value = evaluate(rhs, scope);
            contribution = c.kind === "plus" ? plusJoin(joined, value) : value;
          }
          joined = core.join(joined, contribution);
          if (joined.kind === "dynamic") break;
        }
        return joined;
      } finally {
        visiting.delete(sym);
      }
    },
  };
}
