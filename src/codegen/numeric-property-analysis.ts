// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3683 S4a — whole-program "this property name only ever holds a number"
 * analysis, used to give fnctor struct fields a PHYSICAL `f64` slot instead of
 * a boxed `externref` one.
 *
 * ## Why this exists (the measured motivation)
 *
 * #3683 S2 gave acorn's prototype methods typed-`this` twins, so `this.pos`
 * lowers to a bare `struct.get` instead of a `__get_member_pos` dispatcher
 * call. The measurement (S2 notes in `plan/issues/3683-…`) showed only ~5 %:
 * `$__fnctor_Parser`'s hot fields (`pos`, `start`, `end`, `lastTokEnd`,
 * `lineStart`, …) all derive **externref**, so the twin's `struct.get` hands
 * back a BOXED value that the consumer immediately unboxes through a
 * `__unbox_number` call. S2 removed the dispatcher call, not the boxing.
 *
 * They derive externref because `deriveFnctorFields` types a field from the
 * FIRST constructor write's checker type, and acorn is plain JS where `this`
 * is `any`:
 *
 *     if (startPos) { this.pos = startPos; … }   // ← first write, `any`
 *     else          { this.pos = this.lineStart = 0; }
 *
 * The first write wins and `startPos: any` ⇒ externref, even though every one
 * of `pos`'s 82 writes across the whole parser is numeric.
 *
 * ## What this analyses
 *
 * A property NAME (not a per-class field — see "Why name-keyed" below) is
 * `numeric` when its **complete statically visible write set** is numeric:
 *
 *  - at least one write is PROVABLY numeric (so a name written only through
 *    opaque values never gets promoted — `this.value = val` alone must not
 *    make `value` an f64 slot), and
 *  - every write is either provably numeric, an arithmetic compound
 *    (`-=`/`*=`/`>>=`/`++`/`--`, which JS defines as ToNumeric-producing
 *    regardless of operand), or a bare read of a PARAMETER that is nowhere
 *    given a provably non-numeric value (the documented trust boundary below).
 *
 * Anything else — a `null`, a string, an object/array literal, a `new X()`, a
 * call whose return is not provably numeric, a property read of a name that is
 * not itself numeric — demotes the name, permanently and program-wide.
 *
 * ### The one trust boundary: bare parameter reads
 *
 * `pos` is the keystone: everything else in acorn's tokenizer (`start`, `end`,
 * `lastTokStart`, `lastTokEnd`, `potentialArrowAt`, `yieldPos`, …) is written
 * from `this.pos`, so if `pos` fails they all fail. Its writes are numeric
 * except ONE: `this.pos = startPos` in the constructor, whose value comes from
 * the public `parseExpressionAt(input, pos, options)` entry point. No sound
 * intra-module analysis can prove an entry-point parameter numeric, so a fully
 * sound analysis yields exactly zero on the benchmark target.
 *
 * We therefore accept bare parameter reads as `opaque` rather than as
 * `non-numeric`, which means a non-number written through such a site is
 * **ToNumber-coerced** by the slot's `externref → f64` write coercion. Four
 * things make that a bounded, deliberate choice rather than a silent hazard:
 *
 *  1. **It is the status quo, narrowed.** Today's derivation already types a
 *     field from ONE write and ToNumber-coerces every other write to it —
 *     `awaitPos` is f64 today, so `parser.awaitPos = "x"` already stores NaN.
 *     This analysis demands strictly MORE evidence (every write agrees) before
 *     making that same choice.
 *  2. **The opaque form is deliberately minimal**: only a bare identifier
 *     resolving to a PARAMETER slot that is nowhere given a provably
 *     non-numeric value. A property read (`this.type = types$1.eof`), a call
 *     (`this.context = this.initialContext()`) or a literal (`this.value =
 *     null`) is NOT opaque — it demotes. That is what keeps `type`, `value`,
 *     `options`, `input`, `strict` and friends on externref.
 *  3. **≥1 provably numeric write is required**, so a name whose every write
 *     is a parameter read is never promoted.
 *  4. It is off unless `ctx.standalone` — the host lane, where a JS caller can
 *     hand the module arbitrary values, is untouched.
 *
 * ### Why name-keyed rather than per-(class, field)
 *
 * It mirrors `analyzeBooleanPropertyNames` (#2847), which brands boolean
 * struct fields the same way, and it is strictly MORE conservative: a numeric
 * `pos` in one class and a string `pos` in another demote each other. That
 * conservatism is what lets the verdict be consumed by a name-keyed derivation
 * without tracking which receiver an `obj.pos = v` write reached — the alias
 * problem a per-class analysis would have to solve with a points-to analysis
 * we do not have.
 *
 * ### Sentinels (hard disables)
 *
 *  - a computed member WRITE or `delete` whose receiver is `this` or a
 *    #2660 receiver-flow-proven fnctor instance ⇒ the whole analysis returns
 *    empty. Such a write can hit ANY field name with ANY value, so no name is
 *    provable. (Acorn's computed writes — `keywordTypes[name] = …`,
 *    `this.context[i] = …`, `this.undefinedExports[k] = …` — all have a plain
 *    object / array / module-table receiver, never a bare fnctor instance, so
 *    acorn does not trip this. Mirrors S1b's `otherNameWrites = null`.)
 *  - a property NAME that is `delete`d anywhere is excluded. The standalone
 *    struct-delete lowering writes an undefined SENTINEL into the slot (NaN
 *    for f64, `ref.null` for refs); rather than reason about NaN-vs-real-NaN
 *    aliasing on a promoted slot, delete targets simply keep externref.
 *
 * ### Lexical slots, not pooled names
 *
 * Local/parameter values are keyed by **(declaring function frame, name)**, not
 * by bare name. Pooling by name — which #2847 does, and which is sound but
 * imprecise — merges every `i`, `end`, `size` and `pos` in a 230 KB module into
 * one verdict, and a single non-numeric one anywhere sinks them all. A cheap
 * syntactic scope walk (params + hoisted `var`/`function` + `let`/`const`,
 * block scopes merged into their function frame, which only ever pools MORE
 * definitions) recovers the precision without a symbol table.
 */
import { forEachChild, ts } from "../ts-api.js";

/** The host facts this analysis needs; kept tiny so it can run standalone. */
export interface NumericPropertyAnalysisHost {
  /**
   * Type oracle (`ctx.oracle`). Used only as a FAST PATH for annotated code:
   * when the oracle already says an expression is a number the syntactic
   * prover is skipped. Never consulted to demote — an `any` verdict just means
   * "keep proving syntactically", which is the JS case this analysis targets.
   */
  readonly oracle?: { typeFactOf(node: ts.Node): { kind: string } };
  /**
   * (#2660) Expressions the fnctor receiver-flow map proved to hold a fnctor
   * instance. A computed write through one of these is the sentinel above.
   */
  readonly fnctorReceivers?: ReadonlySet<ts.Expression>;
  /**
   * Property names #2847's `analyzeBooleanPropertyNames` already claims. Those
   * slots belong to the boolean brand (`recoverBooleanStructFieldBrands` turns
   * them into branded i32) and must not be promoted to f64 here — an unbranded
   * f64 would make acorn's `node.static === false` answer `false` where JS says
   * `true`. Passing the REAL #2847 verdict (rather than re-deriving it) makes
   * the two passes agree by construction; {@link Prover.isBooleanish} is only
   * the local, weaker backstop for hosts that do not supply it.
   */
  readonly excludeNames?: ReadonlySet<string>;
  /**
   * (#4121 slice 2) "Does this direct call resolve to a declaration whose
   * return the binding-aware least fixpoint proved to be a plain `f64`?"
   *
   * The prover's own call arm is `numericFunctions`, a NAME-keyed set: one
   * same-named function-like anywhere in the program that is not numeric
   * withdraws the name for every declaration sharing it. This predicate is
   * declaration-resolved and recovers exactly that lost precision. Absent on
   * the first pass — see `bindingAwareNumericCallEvidence`, which supplies it
   * only when it can add something.
   */
  readonly provenNumericCallReturn?: (call: ts.CallExpression) => boolean;
}

type FunctionLike = ts.FunctionLikeDeclaration & { body: ts.ConciseBody };
/** A function-like body or the source file — the granularity of a value slot. */
type Frame = ts.Node;

/** One recorded definition of a value slot. `expr` absent ⇒ opaque/unknown. */
interface ValueDef {
  readonly expr?: ts.Expression;
  /** `x++` / `x -= 1`: JS guarantees a number regardless of the old value. */
  readonly forcedNumeric?: boolean;
  /**
   * An inconclusive value forwarded by a direct recursive call cannot be
   * discarded when agreeing an implicit-any parameter ABI (#3961).
   */
  readonly dynamicConflict?: boolean;
}

/** A resolved (frame, name) variable slot. */
interface Slot {
  readonly name: string;
  readonly defs: ValueDef[];
  isParam: boolean;
}

/** One recorded write to a property NAME. */
interface PropWrite {
  readonly name: string;
  readonly value?: ts.Expression;
  readonly forcedNumeric?: boolean;
  /**
   * For a `this.f += rhs` write, the RHS alone. `+=` is the one compound JS can
   * answer with a string, so unlike `-=`/`*=` it is not `forcedNumeric`; but the
   * LHS is the slot itself (numeric by induction) so `number + <opaque param>`
   * lands in exactly the ToNumber-coerced trust boundary a plain
   * `this.f = <param>` write already takes. Acorn's `this.pos += size` in
   * `finishOp` is the shape.
   */
  readonly plusEqualsRhs?: ts.Expression;
}

/** Binary operators whose result is a number for ANY operand (ToNumeric). */
const ALWAYS_NUMERIC_BINARY: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.MinusToken,
  ts.SyntaxKind.AsteriskToken,
  ts.SyntaxKind.SlashToken,
  ts.SyntaxKind.PercentToken,
  ts.SyntaxKind.AsteriskAsteriskToken,
  ts.SyntaxKind.AmpersandToken,
  ts.SyntaxKind.BarToken,
  ts.SyntaxKind.CaretToken,
  ts.SyntaxKind.LessThanLessThanToken,
  ts.SyntaxKind.GreaterThanGreaterThanToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
]);

/** Compound-assignment forms of {@link ALWAYS_NUMERIC_BINARY} (NOT `+=`). */
const ALWAYS_NUMERIC_COMPOUND: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.PercentEqualsToken,
  ts.SyntaxKind.AsteriskAsteriskEqualsToken,
  ts.SyntaxKind.AmpersandEqualsToken,
  ts.SyntaxKind.BarEqualsToken,
  ts.SyntaxKind.CaretEqualsToken,
  ts.SyntaxKind.LessThanLessThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
]);

/** Comparisons — boolean, which an f64 (or i32-boolean) slot represents. */
const BOOLEAN_BINARY: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.InstanceOfKeyword,
  ts.SyntaxKind.InKeyword,
]);

/** `<string>.m(…)` results that are always numbers. */
const STRING_NUMERIC_METHODS: ReadonlySet<string> = new Set([
  "indexOf",
  "lastIndexOf",
  "charCodeAt",
  "codePointAt",
  "search",
  "localeCompare",
]);

/** `<array>.m(…)` results that are always numbers. */
const ARRAY_NUMERIC_METHODS: ReadonlySet<string> = new Set(["indexOf", "lastIndexOf", "push", "unshift"]);

/** `<string>.m(…)` results that are always strings. */
const STRING_STRING_METHODS: ReadonlySet<string> = new Set([
  "slice",
  "substring",
  "substr",
  "replace",
  "replaceAll",
  "toLowerCase",
  "toUpperCase",
  "toLocaleLowerCase",
  "toLocaleUpperCase",
  "trim",
  "trimStart",
  "trimEnd",
  "charAt",
  "concat",
  "repeat",
  "padStart",
  "padEnd",
  "normalize",
]);

/** Global functions whose result is always a number. */
const NUMERIC_GLOBAL_CALLS: ReadonlySet<string> = new Set(["parseInt", "parseFloat", "Number"]);

function unwrap(expr: ts.Expression): ts.Expression {
  let current = expr;
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

function isFunctionLikeWithBody(node: ts.Node): node is FunctionLike {
  return ts.isFunctionLike(node) && "body" in node && node.body !== undefined;
}

function propertyNameText(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

/** The written property NAME of an assignment LHS, or `undefined` if computed. */
function assignmentPropertyName(lhs: ts.Expression): string | undefined {
  const target = unwrap(lhs);
  if (ts.isPropertyAccessExpression(target) && !ts.isPrivateIdentifier(target.name)) return target.name.text;
  if (
    ts.isElementAccessExpression(target) &&
    target.argumentExpression &&
    (ts.isStringLiteral(target.argumentExpression) || ts.isNumericLiteral(target.argumentExpression))
  ) {
    return target.argumentExpression.text;
  }
  return undefined;
}

/** Same binding-name resolution `analyzeBooleanPropertyNames` uses (#2847). */
function functionBindingName(fn: FunctionLike): string | undefined {
  if (fn.name && ts.isIdentifier(fn.name)) return fn.name.text;
  const parent = fn.parent;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  if (ts.isBinaryExpression(parent) && parent.right === fn) return assignmentPropertyName(parent.left);
  if (ts.isPropertyAssignment(parent)) return propertyNameText(parent.name);
  return undefined;
}

/**
 * Aggregation key for a call. Plain `f(…)` / `new F(…)` and `this.m(…)` only —
 * an arbitrary `obj.m(…)` must NOT be aggregated by textual property name (a
 * user `find()` and `Array#find` are unrelated symbols). Identical rule to the
 * #2847 pass, plus `new` (fnctor constructors are the whole point here).
 */
function callName(expr: ts.CallExpression | ts.NewExpression): string | undefined {
  const callee = unwrap(expr.expression);
  if (ts.isIdentifier(callee)) return callee.text;
  if (
    ts.isPropertyAccessExpression(callee) &&
    callee.expression.kind === ts.SyntaxKind.ThisKeyword &&
    !ts.isPrivateIdentifier(callee.name)
  ) {
    return callee.name.text;
  }
  return undefined;
}

/**
 * Statements after which control provably cannot reach the end of the body.
 * Without this, `function f(c) { if (c) return 1; }` looks like it returns only
 * numbers when in fact it returns `undefined` on the other path — the same
 * guard #2847's boolean-function inference uses, and load-bearing for the same
 * reason.
 */
function statementDefinitelyReturns(stmt: ts.Statement): boolean {
  if (ts.isReturnStatement(stmt) || ts.isThrowStatement(stmt)) return true;
  if (ts.isBlock(stmt)) return stmt.statements.some(statementDefinitelyReturns);
  if (ts.isIfStatement(stmt) && stmt.elseStatement) {
    return statementDefinitelyReturns(stmt.thenStatement) && statementDefinitelyReturns(stmt.elseStatement);
  }
  return false;
}

/** Return expressions of `fn`, or `undefined` when a path falls off the end. */
function ownReturnExpressions(fn: FunctionLike): ts.Expression[] | undefined {
  if (!ts.isBlock(fn.body)) return [fn.body];
  if (!fn.body.statements.some(statementDefinitelyReturns)) return undefined;
  const returns: ts.Expression[] = [];
  let bareReturn = false;
  const visit = (node: ts.Node): void => {
    if (node !== fn && isFunctionLikeWithBody(node)) return;
    if (ts.isReturnStatement(node)) {
      if (node.expression) returns.push(node.expression);
      else bareReturn = true;
      return;
    }
    forEachChild(node, visit);
  };
  forEachChild(fn.body, visit);
  return !bareReturn && returns.length > 0 ? returns : undefined;
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  const out: string[] = [];
  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) continue;
    out.push(...bindingNames(element.name));
  }
  return out;
}

/**
 * Whether a computed member access / delete goes through something that could
 * BE a fnctor instance (as opposed to a plain object or array a field happens
 * to hold). Only `this` and #2660-proven receivers qualify; everything else is
 * a value the fnctor merely points at, whose own shape this analysis does not
 * type.
 */
function isFnctorInstanceReceiver(recv: ts.Expression, host: NumericPropertyAnalysisHost): boolean {
  const target = unwrap(recv);
  if (target.kind === ts.SyntaxKind.ThisKeyword) return true;
  return host.fnctorReceivers?.has(target) === true;
}

// ---------------------------------------------------------------------------
// Scope resolution
// ---------------------------------------------------------------------------

/**
 * A syntactic scope table: every function-like (and the source file) owns the
 * names it declares. Block scopes are merged into their function frame — that
 * only ever pools MORE definitions into one slot, so it can lose precision but
 * never soundness.
 */
class ScopeTable {
  private readonly declared = new Map<Frame, Map<string, Slot>>();

  frameOf(node: ts.Node): Frame {
    let current: ts.Node | undefined = node;
    while (current) {
      if (isFunctionLikeWithBody(current) || ts.isSourceFile(current)) return current;
      current = current.parent;
    }
    return node.getSourceFile();
  }

  declare(frame: Frame, name: string, isParam: boolean): Slot {
    let names = this.declared.get(frame);
    if (!names) this.declared.set(frame, (names = new Map()));
    let slot = names.get(name);
    if (!slot) names.set(name, (slot = { name, defs: [], isParam }));
    else if (isParam) slot.isParam = true;
    return slot;
  }

  /** Resolve a reference: nearest enclosing frame that declares `name`. */
  resolve(node: ts.Node, name: string): Slot | undefined {
    let current: ts.Node | undefined = this.frameOf(node);
    while (current) {
      const slot = this.declared.get(current)?.get(name);
      if (slot) return slot;
      if (ts.isSourceFile(current) || current.parent === undefined) return undefined;
      current = this.frameOf(current.parent);
    }
    return undefined;
  }

  allSlots(): Slot[] {
    const out: Slot[] = [];
    for (const names of this.declared.values()) out.push(...names.values());
    return out;
  }
}

/** Pass 1 — declare every binding in its owning frame. */
function buildScopes(sourceFiles: readonly ts.SourceFile[]): ScopeTable {
  const scopes = new ScopeTable();
  for (const sourceFile of sourceFiles) {
    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node)) {
        for (const name of bindingNames(node.name)) scopes.declare(scopes.frameOf(node), name, false);
      } else if (ts.isParameter(node)) {
        const frame = isFunctionLikeWithBody(node.parent) ? node.parent : scopes.frameOf(node);
        for (const name of bindingNames(node.name)) scopes.declare(frame, name, true);
      } else if (ts.isFunctionDeclaration(node) && node.name) {
        scopes.declare(scopes.frameOf(node), node.name.text, false);
      } else if (ts.isCatchClause(node) && node.variableDeclaration) {
        for (const name of bindingNames(node.variableDeclaration.name)) {
          scopes.declare(scopes.frameOf(node), name, false);
        }
      }
      if (node.kind > ts.SyntaxKind.LastToken) forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return scopes;
}

// ---------------------------------------------------------------------------
// Fact collection
// ---------------------------------------------------------------------------

interface NumericFlowFacts {
  readonly scopes: ScopeTable;
  functionsByName: Map<string, FunctionLike[]>;
  calls: Map<string, { args: ts.Expression[]; recursive: boolean }[]>;
  parameters: { slot: Slot; owner: string; index: number; initializer?: ts.Expression }[];
  propertyWrites: PropWrite[];
  deletedNames: Set<string>;
  /** A computed write/delete through a fnctor instance ⇒ nothing is provable. */
  poisoned: boolean;
}

/**
 * Trip the hard sentinel, reporting the offending site under
 * `JS2WASM_NUMERIC_FIELDS_DEBUG=1` — a single unrecognised computed write in a
 * 230 KB module zeroes the whole analysis, so it must be nameable.
 */
function notePoison(facts: { poisoned: boolean }, node: ts.Node): void {
  facts.poisoned = true;
  if (process.env.JS2WASM_NUMERIC_FIELDS_DEBUG === "1") {
    process.stderr.write(`[numeric-fields] poison site: ${node.getText().slice(0, 90).replace(/\s+/g, " ")}\n`);
  }
}

/**
 * The one computed-write shape that does NOT poison a name-keyed analysis:
 * `a[k] = b[k]` with the SAME key variable on both sides — acorn's
 * `pp.copyNode`'s `for (var prop in node) { newNode[prop] = node[prop] }`.
 *
 * Whatever name it writes, it writes the value it just read from **that same
 * name**. A name-keyed verdict says "every write to name X anywhere is
 * numeric", so `b[X]` is a number whenever X is a promoted slot, and copying it
 * into `a[X]` preserves that. The receivers may even be different classes: the
 * verdict is not per-class, so it holds for both.
 *
 * The two key reads are provably equal: a bare identifier read has no side
 * effects, and nothing between the LHS reference evaluation and the RHS
 * evaluation can rebind it. Both keys must therefore resolve to the SAME
 * lexical slot, not merely share a name.
 */
function isSameKeyCopy(node: ts.Node, scopes: ScopeTable): boolean {
  if (!ts.isBinaryExpression(node) || node.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return false;
  const lhs = unwrap(node.left);
  const rhs = unwrap(node.right);
  if (!ts.isElementAccessExpression(lhs) || !ts.isElementAccessExpression(rhs)) return false;
  const lhsKey = unwrap(lhs.argumentExpression);
  const rhsKey = unwrap(rhs.argumentExpression);
  if (!ts.isIdentifier(lhsKey) || !ts.isIdentifier(rhsKey) || lhsKey.text !== rhsKey.text) return false;
  const slot = scopes.resolve(lhsKey, lhsKey.text);
  return slot !== undefined && slot === scopes.resolve(rhsKey, rhsKey.text);
}

/** Pass 2 — index every definition, call, property write and delete. */
function collectNumericFlowFacts(
  sourceFiles: readonly ts.SourceFile[],
  scopes: ScopeTable,
  host: NumericPropertyAnalysisHost,
): NumericFlowFacts {
  const facts: NumericFlowFacts = {
    scopes,
    functionsByName: new Map(),
    calls: new Map(),
    parameters: [],
    propertyWrites: [],
    deletedNames: new Set(),
    poisoned: false,
  };
  const define = (node: ts.Node, name: string, def: ValueDef): void => {
    scopes.resolve(node, name)?.defs.push(def);
  };
  const recordWrite = (name: string | undefined, write: Omit<PropWrite, "name">): void => {
    if (name === undefined) return;
    facts.propertyWrites.push({ name, ...write });
  };

  for (const sourceFile of sourceFiles) {
    const visit = (node: ts.Node): void => {
      if (isFunctionLikeWithBody(node)) {
        const name = functionBindingName(node);
        if (name) {
          const list = facts.functionsByName.get(name);
          if (list) list.push(node);
          else facts.functionsByName.set(name, [node]);
        }
      }

      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const name = callName(node);
        if (name) {
          const args = [...(node.arguments ?? [])];
          let owner: ts.Node | undefined = node.parent;
          while (owner && !isFunctionLikeWithBody(owner)) owner = owner.parent;
          // This is deliberately conservative: a same-name call nested in a
          // function is treated as recursive even when lexical resolution
          // could distinguish it. A false positive only withholds narrowing.
          const recursive = owner !== undefined && functionBindingName(owner) === name;
          const list = facts.calls.get(name);
          if (list) list.push({ args, recursive });
          else facts.calls.set(name, [{ args, recursive }]);
        }
      } else if (ts.isVariableDeclaration(node)) {
        if (ts.isIdentifier(node.name)) {
          // An uninitialised `var x;` can be READ as `undefined` before any
          // later write, so it contributes an opaque definition rather than
          // nothing — otherwise `var x; if (c) x = 1; o.f = x` looks numeric.
          define(node, node.name.text, node.initializer ? { expr: node.initializer } : {});
        } else {
          for (const name of bindingNames(node.name)) define(node, name, {});
        }
      } else if (ts.isBinaryExpression(node) && ts.isIdentifier(unwrap(node.left))) {
        const target = (unwrap(node.left) as ts.Identifier).text;
        const op = node.operatorToken.kind;
        if (op === ts.SyntaxKind.EqualsToken) define(node, target, { expr: node.right });
        else if (ALWAYS_NUMERIC_COMPOUND.has(op)) define(node, target, { forcedNumeric: true });
        else if (op === ts.SyntaxKind.PlusEqualsToken) define(node, target, { expr: node });
        else if (op >= ts.SyntaxKind.FirstAssignment && op <= ts.SyntaxKind.LastAssignment) define(node, target, {});
      } else if (ts.isParameter(node) && isFunctionLikeWithBody(node.parent)) {
        const owner = functionBindingName(node.parent);
        const index = node.parent.parameters.indexOf(node);
        if (ts.isIdentifier(node.name)) {
          const slot = scopes.resolve(node.parent, node.name.text);
          if (slot) {
            if (owner) {
              facts.parameters.push({
                slot,
                owner,
                index,
                ...(node.initializer ? { initializer: node.initializer } : {}),
              });
            } else {
              slot.defs.push({});
            }
          }
        } else {
          for (const name of bindingNames(node.name)) scopes.resolve(node.parent, name)?.defs.push({});
        }
      } else if (ts.isForInStatement(node) || ts.isForOfStatement(node)) {
        // `for (var k in o)` binds a property key / arbitrary element.
        const init = node.initializer;
        if (ts.isVariableDeclarationList(init)) {
          for (const decl of init.declarations) for (const name of bindingNames(decl.name)) define(node, name, {});
        } else if (ts.isIdentifier(unwrap(init as ts.Expression))) {
          define(node, (unwrap(init as ts.Expression) as ts.Identifier).text, {});
        }
      } else if (ts.isCatchClause(node) && node.variableDeclaration) {
        for (const name of bindingNames(node.variableDeclaration.name)) define(node, name, {});
      }

      // --- property writes -------------------------------------------------
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      ) {
        const lhs = unwrap(node.left);
        const op = node.operatorToken.kind;
        if (ts.isElementAccessExpression(lhs) && assignmentPropertyName(lhs) === undefined) {
          if (isFnctorInstanceReceiver(lhs.expression, host) && !isSameKeyCopy(node, scopes)) notePoison(facts, node);
        } else if (ts.isPropertyAccessExpression(lhs) || ts.isElementAccessExpression(lhs)) {
          const name = assignmentPropertyName(lhs);
          if (op === ts.SyntaxKind.EqualsToken) recordWrite(name, { value: node.right });
          else if (ALWAYS_NUMERIC_COMPOUND.has(op)) recordWrite(name, { forcedNumeric: true });
          else if (op === ts.SyntaxKind.PlusEqualsToken) recordWrite(name, { value: node, plusEqualsRhs: node.right });
          else recordWrite(name, {});
        }
      } else if (
        (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
        (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
      ) {
        const operand = unwrap(node.operand as ts.Expression);
        if (ts.isElementAccessExpression(operand) && assignmentPropertyName(operand) === undefined) {
          if (isFnctorInstanceReceiver(operand.expression, host)) notePoison(facts, node);
        } else if (ts.isPropertyAccessExpression(operand) || ts.isElementAccessExpression(operand)) {
          recordWrite(assignmentPropertyName(operand), { forcedNumeric: true });
        } else if (ts.isIdentifier(operand)) {
          define(node, operand.text, { forcedNumeric: true });
        }
      } else if (ts.isPropertyAssignment(node)) {
        recordWrite(propertyNameText(node.name), { value: node.initializer });
      } else if (ts.isShorthandPropertyAssignment(node)) {
        recordWrite(node.name.text, { value: node.name });
      } else if (ts.isPropertyDeclaration(node)) {
        recordWrite(propertyNameText(node.name), node.initializer ? { value: node.initializer } : {});
      } else if (ts.isPropertySignature(node) || ts.isMethodDeclaration(node) || ts.isAccessor(node)) {
        // A declared-but-unwritten slot, an accessor, or a method: no numeric
        // evidence, and an accessor must never be turned into a raw slot.
        recordWrite(propertyNameText(node.name), {});
      } else if (ts.isDeleteExpression(node)) {
        const target = unwrap(node.expression);
        if (ts.isPropertyAccessExpression(target)) facts.deletedNames.add(target.name.text);
        else if (ts.isElementAccessExpression(target)) {
          const name = assignmentPropertyName(target);
          if (name !== undefined) facts.deletedNames.add(name);
          else if (isFnctorInstanceReceiver(target.expression, host)) notePoison(facts, node);
        }
      }

      if (node.kind > ts.SyntaxKind.LastToken) forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return facts;
}

/**
 * Property names whose every write is a GROUND string expression — a literal, a
 * template, a `String(x)` call, or a string method on another ground string.
 * Deliberately non-recursive over property names: the single consumer is "is
 * this receiver a string?", and acorn needs exactly one entry (`input`, from
 * `this.input = String(input)`) to unlock `this.input.indexOf(…)` and
 * `this.input.slice(…).split(…).length` as numeric.
 */
/**
 * (#3753 S1) Property names whose EVERY write is provably a string.
 *
 * `scopes` makes the prover slot-aware. Without it this was purely syntactic —
 * a literal, a template, `String(x)`, a string method on a ground string, or a
 * `+` with one ground side — which cannot see through the single most common
 * shape there is:
 *
 *     function Tok(input) { this.input = input; }   // `input` is a PARAMETER
 *
 * A parameter read is not a literal, so `this.input` was never provably a
 * string and its fnctor slot stayed `externref` — costing a
 * `ref.test` + `ref.cast` + `__str_flatten` on every access (#3753).
 *
 * Following an identifier to its slot and requiring EVERY definition to be a
 * ground string closes that. The slot's defs are already seeded from call-site
 * arguments by the caller, so a constructor parameter resolves to the values
 * actually passed. `visited` breaks the cycles that seeding can create
 * (`f(x)` calling `f(x)`), and an EMPTY def list or a def with no expression is
 * an opaque value — the trust boundary — and answers false.
 */
function collectStringProperties(facts: NumericFlowFacts, scopes: ScopeTable): Set<string> {
  const visited = new Set<Slot>();
  /**
   * (#3765) Only as much array-ness as `<array>.join(…)` needs: an array
   * literal, or a slot whose every definition is one. Same slot walk and cycle
   * guard as {@link isGroundString}, with its own in-flight set so a
   * `join`-of-a-slot cannot collide with a string slot already being proven.
   */
  const arrayVisited = new Set<Slot>();
  const isGroundArray = (expr: ts.Expression, depth: number): boolean => {
    if (depth > 8) return false;
    const value = unwrap(expr);
    if (ts.isArrayLiteralExpression(value)) return true;
    if (!ts.isIdentifier(value)) return false;
    const slot = scopes.resolve(value, value.text);
    if (!slot || slot.defs.length === 0 || arrayVisited.has(slot)) return false;
    arrayVisited.add(slot);
    try {
      return slot.defs.every((def) => def.expr !== undefined && isGroundArray(def.expr, depth + 1));
    } finally {
      arrayVisited.delete(slot);
    }
  };
  const isGroundString = (expr: ts.Expression, depth: number): boolean => {
    if (depth > 8) return false;
    const value = unwrap(expr);
    if (ts.isIdentifier(value)) {
      const slot = scopes.resolve(value, value.text);
      // No slot (a global / import) or a slot we are already proving (a cycle)
      // is not provable. `defs.length === 0` means "declared, never defined".
      if (!slot || slot.defs.length === 0 || visited.has(slot)) return false;
      visited.add(slot);
      try {
        return slot.defs.every((def) => def.expr !== undefined && isGroundString(def.expr, depth + 1));
      } finally {
        visited.delete(slot);
      }
    }
    if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value) || ts.isTemplateExpression(value)) {
      return true;
    }
    if (ts.isCallExpression(value)) {
      const callee = unwrap(value.expression);
      if (ts.isIdentifier(callee) && callee.text === "String") return true;
      if (
        ts.isPropertyAccessExpression(callee) &&
        STRING_STRING_METHODS.has(callee.name.text) &&
        isGroundString(callee.expression, depth + 1)
      ) {
        return true;
      }
      // `<array>.join(…)` — a String for ANY array (§23.1.3.16), so no element
      // proof is needed. See the twin clause in `makeProver`'s `isString`.
      if (
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === "join" &&
        isGroundArray(callee.expression, depth + 1)
      ) {
        return true;
      }
    }
    if (ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      return isGroundString(value.left, depth + 1) || isGroundString(value.right, depth + 1);
    }
    return false;
  };
  const state = new Map<string, boolean>();
  for (const write of facts.propertyWrites) {
    const ok = write.value !== undefined && isGroundString(write.value, 0);
    const prev = state.get(write.name);
    state.set(write.name, prev === undefined ? ok : prev && ok);
  }
  return new Set([...state].filter(([, ok]) => ok).map(([name]) => name));
}

// ---------------------------------------------------------------------------
// The prover
// ---------------------------------------------------------------------------

interface FixpointSets {
  readonly numericProperties: ReadonlySet<string>;
  readonly numericSlots: ReadonlySet<Slot>;
  readonly numericFunctions: ReadonlySet<string>;
}

interface Prover {
  isNumeric(expr: ts.Expression): boolean;
  isString(expr: ts.Expression): boolean;
  isBooleanish(expr: ts.Expression): boolean;
  isOpaqueParamRead(expr: ts.Expression): boolean;
  withSelf<T>(name: string, run: () => T): T;
  withoutSelf<T>(name: string, run: () => T): T;
}

/**
 * Mirror implicit-any call-site ABI agreement for the whole-program carrier
 * fixpoint. A concrete conflicting argument vetoes narrowing. An argument the
 * checker still reports as `any`/`unknown` contributes no evidence, matching
 * `inferParamTypeFromCallSites`; the one exception is a dynamic value forwarded
 * recursively, which is part of the callee's runtime domain (#3961).
 *
 * Missing arguments are ignored here. Declaration lowering separately widens
 * inferred reference parameters to nullable and applies the ordinary numeric
 * boundary coercion, exactly as it does for the call-site inference result.
 */
function parameterDefinitionsAgree(
  slot: Slot,
  host: NumericPropertyAnalysisHost,
  provesCarrier: (def: ValueDef) => boolean,
): boolean {
  let hasEvidence = false;
  for (const def of slot.defs) {
    if (provesCarrier(def)) {
      hasEvidence = true;
      continue;
    }
    if (def.dynamicConflict) return false;
    if (def.expr === undefined) continue;
    const kind = host.oracle?.typeFactOf(unwrap(def.expr)).kind;
    if (kind !== "any" && kind !== "unknown" && kind !== "unresolvable") return false;
  }
  return hasEvidence;
}

/**
 * Every clause below is a JS-semantics fact, not a heuristic. The three
 * fixpoint sets are consulted optimistically; groundedness is re-checked after
 * convergence.
 */
function makeProver(
  facts: NumericFlowFacts,
  host: NumericPropertyAnalysisHost,
  stringProperties: ReadonlySet<string>,
  sets: FixpointSets,
): Prover {
  const MAX_DEPTH = 48;
  /**
   * The property currently being judged. A write may READ the slot it writes
   * (`this.pos += 2`, `this.yieldPos = old || this.yieldPos`), and such a read
   * must not be what demotes the slot: by induction, if every OTHER write
   * stores a number then the slot always holds one (a promoted slot's WasmGC
   * default is `0.0`, itself a number), so the self-read is numeric. Without
   * this, every compound write is self-demoting and the analysis collapses.
   */
  let selfName: string | undefined;
  /**
   * The mirror image of {@link selfName}, used by the GROUNDEDNESS pass: while
   * judging whether property `p` has any write that proves it numeric, a read
   * of `p` (through ANY receiver — this is a name-keyed analysis) proves
   * nothing. Without it, `this.keyword = conf.keyword` grounds `keyword` on
   * itself and a string-valued TokenType slot gets promoted to f64.
   */
  let excludedName: string | undefined;
  /** Re-entrancy guard for the slot recursion in {@link isString}. */
  const stringSlotsInFlight = new Set<Slot>();

  const isString = (expr: ts.Expression, depth: number): boolean => {
    if (depth > MAX_DEPTH) return false;
    const value = unwrap(expr);
    if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value) || ts.isTemplateExpression(value)) {
      return true;
    }
    if (ts.isPropertyAccessExpression(value) && stringProperties.has(value.name.text)) return true;
    if (ts.isIdentifier(value)) {
      const slot = facts.scopes.resolve(value, value.text);
      // A local whose every definition is a string (`var s = this.source`).
      if (!slot || slot.defs.length === 0) return false;
      // `var a = b; var b = a` would otherwise branch exponentially inside the
      // depth cap; a slot already on the stack answers `false` (conservative).
      if (stringSlotsInFlight.has(slot)) return false;
      stringSlotsInFlight.add(slot);
      try {
        if (!slot.isParam) {
          return slot.defs.every((def) => def.expr !== undefined && isString(def.expr, depth + 1));
        }
        return parameterDefinitionsAgree(slot, host, (def) => def.expr !== undefined && isString(def.expr, depth + 1));
      } finally {
        stringSlotsInFlight.delete(slot);
      }
    }
    if (ts.isCallExpression(value)) {
      const callee = unwrap(value.expression);
      if (ts.isIdentifier(callee) && callee.text === "String") return true;
      if (
        ts.isPropertyAccessExpression(callee) &&
        STRING_STRING_METHODS.has(callee.name.text) &&
        isString(callee.expression, depth + 1)
      ) {
        return true;
      }
      // `<array>.join(…)` — ECMA-262 §23.1.3.16 returns a String for ANY array,
      // whatever the element types, so no element proof is needed. Added for
      // #3765: the cross-engine benchmark builds its 35 KB tokenizer subject as
      // `__parts.join("")`, and without this the `input` field is not a proven
      // string carrier, so `input.charCodeAt(pos)` is not proven numeric, so the
      // hot local is not proven numeric — the whole chain fails on the exact
      // shape it was written for, while a plain string literal subject works.
      if (
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === "join" &&
        isArray(callee.expression, depth + 1)
      ) {
        return true;
      }
    }
    // Addition produces a string whenever either operand's ToPrimitive result
    // is provably a string. This is the same rule the earlier
    // `collectStringProperties` seed pass already uses, but the main fixpoint
    // omitted it, so a local assembled as `"a=" + dynamicValue + "; b=2"`
    // could not carry string evidence into an imported parser. On every
    // successful evaluation the result is a string; a Symbol operand throws
    // before assigning and therefore cannot introduce a non-string definition.
    if (ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      return isString(value.left, depth + 1) || isString(value.right, depth + 1);
    }
    return false;
  };

  /** Re-entrancy guard for the slot recursion in {@link isArray}. */
  const arraySlotsInFlight = new Set<Slot>();
  /** `<string>.split(…)`, array literals, and array-returning array methods. */
  const isArray = (expr: ts.Expression, depth: number): boolean => {
    if (depth > MAX_DEPTH) return false;
    const value = unwrap(expr);
    if (ts.isArrayLiteralExpression(value)) return true;
    // A local whose every definition is an array (`const parts = [];`), resolved
    // through the same slot walk and cycle guard {@link isString} uses.
    if (ts.isIdentifier(value)) {
      const slot = facts.scopes.resolve(value, value.text);
      if (!slot || slot.defs.length === 0) return false;
      if (arraySlotsInFlight.has(slot)) return false;
      arraySlotsInFlight.add(slot);
      try {
        return slot.defs.every((def) => def.expr !== undefined && isArray(def.expr, depth + 1));
      } finally {
        arraySlotsInFlight.delete(slot);
      }
    }
    if (ts.isCallExpression(value)) {
      const callee = unwrap(value.expression);
      if (!ts.isPropertyAccessExpression(callee)) return false;
      if (callee.name.text === "split" && isString(callee.expression, depth + 1)) return true;
      if (
        (callee.name.text === "slice" || callee.name.text === "filter" || callee.name.text === "concat") &&
        isArray(callee.expression, depth + 1)
      ) {
        return true;
      }
    }
    return false;
  };

  const isNumeric = (expr: ts.Expression, depth: number): boolean => {
    if (depth > MAX_DEPTH) return false;
    const value = unwrap(expr);

    // Fast path for annotated code — never used to demote.
    const fact = host.oracle?.typeFactOf(value);
    if (fact && (fact.kind === "number" || fact.kind === "boolean")) return true;

    if (ts.isNumericLiteral(value)) return true;
    if (value.kind === ts.SyntaxKind.TrueKeyword || value.kind === ts.SyntaxKind.FalseKeyword) return true;
    if (ts.isPrefixUnaryExpression(value)) {
      const op = value.operator;
      return (
        op === ts.SyntaxKind.PlusToken ||
        op === ts.SyntaxKind.MinusToken ||
        op === ts.SyntaxKind.TildeToken ||
        op === ts.SyntaxKind.ExclamationToken ||
        op === ts.SyntaxKind.PlusPlusToken ||
        op === ts.SyntaxKind.MinusMinusToken
      );
    }
    if (ts.isPostfixUnaryExpression(value)) return true;
    if (ts.isTypeOfExpression(value) || ts.isVoidExpression(value)) return false;

    if (ts.isBinaryExpression(value)) {
      const op = value.operatorToken.kind;
      if (ALWAYS_NUMERIC_BINARY.has(op) || ALWAYS_NUMERIC_COMPOUND.has(op) || BOOLEAN_BINARY.has(op)) return true;
      // `+` / `+=` are the only arithmetic-looking forms that can produce a
      // string; both operands must be provably non-string.
      if (op === ts.SyntaxKind.PlusToken || op === ts.SyntaxKind.PlusEqualsToken) {
        return isNumeric(value.left, depth + 1) && isNumeric(value.right, depth + 1);
      }
      if (op === ts.SyntaxKind.EqualsToken) return isNumeric(value.right, depth + 1);
      // `&&` / `||` / `??` evaluate to ONE of the operands.
      if (
        op === ts.SyntaxKind.AmpersandAmpersandToken ||
        op === ts.SyntaxKind.BarBarToken ||
        op === ts.SyntaxKind.QuestionQuestionToken
      ) {
        return isNumeric(value.left, depth + 1) && isNumeric(value.right, depth + 1);
      }
      if (op === ts.SyntaxKind.CommaToken) return isNumeric(value.right, depth + 1);
      return false;
    }
    if (ts.isConditionalExpression(value)) {
      return isNumeric(value.whenTrue, depth + 1) && isNumeric(value.whenFalse, depth + 1);
    }
    if (ts.isIdentifier(value)) {
      const slot = facts.scopes.resolve(value, value.text);
      return slot !== undefined && sets.numericSlots.has(slot);
    }
    if (ts.isPropertyAccessExpression(value)) {
      if (
        value.name.text === "length" &&
        (isString(value.expression, depth + 1) || isArray(value.expression, depth + 1))
      ) {
        return true;
      }
      if (value.name.text === excludedName) return false;
      return value.name.text === selfName || sets.numericProperties.has(value.name.text);
    }
    if (ts.isElementAccessExpression(value)) {
      const key = value.argumentExpression && unwrap(value.argumentExpression);
      if (key && ts.isStringLiteral(key)) {
        if (key.text === excludedName) return false;
        return key.text === selfName || sets.numericProperties.has(key.text);
      }
      return false;
    }
    if (ts.isCallExpression(value)) {
      const callee = unwrap(value.expression);
      if (ts.isIdentifier(callee)) {
        if (NUMERIC_GLOBAL_CALLS.has(callee.text)) return true;
        if (sets.numericFunctions.has(callee.text)) return true;
        // (#4121 slice 2) The declaration-resolved arm. See
        // {@link NumericPropertyAnalysisHost.provenNumericCallReturn}.
        return host.provenNumericCallReturn?.(value) === true;
      }
      if (ts.isPropertyAccessExpression(callee)) {
        const recv = unwrap(callee.expression);
        if (ts.isIdentifier(recv) && recv.text === "Math") return true;
        if (ts.isIdentifier(recv) && recv.text === "Date" && callee.name.text === "now") return true;
        if (STRING_NUMERIC_METHODS.has(callee.name.text) && isString(callee.expression, depth + 1)) return true;
        if (ARRAY_NUMERIC_METHODS.has(callee.name.text) && isArray(callee.expression, depth + 1)) return true;
        if (recv.kind === ts.SyntaxKind.ThisKeyword) return sets.numericFunctions.has(callee.name.text);
        // (#4122) The same verdict for a NON-`this` receiver. `numericFunctions`
        // is whole-program and NAME-keyed — "every visible function of this name
        // returns a number on every path" — which is exactly as true of
        // `p.inc()` as of `this.inc()`; a single non-numeric `inc` anywhere in
        // the program removes the name for both. The `this`-only restriction was
        // conservatism, not a consequence of the verdict.
        //
        // The trust boundary this widens is the SAME one the file documents for
        // name-keying generally: an `inc` that is not statically visible (a host
        // or builtin method reached through an opaque receiver) is not in
        // `functionsByName` and so cannot demote the name. That risk already
        // exists for `this.m()`, whose receiver is equally unconstrained at
        // runtime. Restricted to a bare identifier receiver so member chains
        // (`a.b.inc()`) and call results (`f().inc()`) keep the old answer.
        if (ts.isIdentifier(recv)) return sets.numericFunctions.has(callee.name.text);
      }
      return false;
    }
    return false;
  };

  /**
   * A value JS produces as a BOOLEAN. A name whose every write is boolean is
   * left alone: #2847's `analyzeBooleanPropertyNames` +
   * `recoverBooleanStructFieldBrands` already own those slots (as branded i32),
   * and promoting them to f64 here would race that pass and marshal acorn's
   * `node.computed` / `node.static` / `node.generator` back out as 0/1 numbers.
   */
  const isBooleanish = (expr: ts.Expression, depth: number): boolean => {
    if (depth > MAX_DEPTH) return false;
    const value = unwrap(expr);
    if (value.kind === ts.SyntaxKind.TrueKeyword || value.kind === ts.SyntaxKind.FalseKeyword) return true;
    if (ts.isPrefixUnaryExpression(value) && value.operator === ts.SyntaxKind.ExclamationToken) return true;
    if (ts.isBinaryExpression(value)) {
      const op = value.operatorToken.kind;
      if (BOOLEAN_BINARY.has(op)) return true;
      if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken) {
        return isBooleanish(value.left, depth + 1) && isBooleanish(value.right, depth + 1);
      }
      return false;
    }
    if (ts.isConditionalExpression(value)) {
      return isBooleanish(value.whenTrue, depth + 1) && isBooleanish(value.whenFalse, depth + 1);
    }
    if (ts.isCallExpression(value)) {
      const callee = unwrap(value.expression);
      return ts.isIdentifier(callee) && callee.text === "Boolean";
    }
    return false;
  };

  return {
    isNumeric: (expr) => isNumeric(expr, 0),
    isString: (expr) => isString(expr, 0),
    isBooleanish: (expr) => isBooleanish(expr, 0),
    // The documented trust boundary — see the module header. A bare identifier
    // resolving to a PARAMETER slot. Anything more structured (a property read,
    // a call, a literal) is NOT opaque and demotes its property.
    isOpaqueParamRead: (expr) => {
      const value = unwrap(expr);
      if (!ts.isIdentifier(value)) return false;
      return facts.scopes.resolve(value, value.text)?.isParam === true;
    },
    withSelf: (name, run) => {
      const saved = selfName;
      selfName = name;
      try {
        return run();
      } finally {
        selfName = saved;
      }
    },
    withoutSelf: (name, run) => {
      const saved = excludedName;
      excludedName = name;
      try {
        return run();
      } finally {
        excludedName = saved;
      }
    },
  };
}

/** `JS2WASM_NUMERIC_FIELDS_DEBUG=1` — print the verdict set once per compile. */
function debugEnabled(): boolean {
  return process.env.JS2WASM_NUMERIC_FIELDS_DEBUG === "1";
}

/**
 * Compute the property names whose complete visible write set is numeric.
 *
 * Three interlocking optimistic (greatest) fixpoints — function returns, value
 * slots, property names — each shrinking monotonically from "everything is
 * numeric" until stable. Optimism is safe because every surviving candidate
 * must still pass the final GROUNDEDNESS filter: a name whose numericness rests
 * only on a cycle of other names contributes no provably-numeric write and is
 * dropped.
 */
/**
 * (#3753 S1) The whole-program field verdicts `deriveFnctorFields` promotes on.
 * `numeric` is #3683 S4a's; `string` is the slot-aware string-carrier set.
 */
export interface PropertyKindVerdicts {
  readonly numeric: Set<string>;
  readonly string: Set<string>;
  /**
   * (#3753 S2) Function NAMES the fixpoint proved return a number on every
   * path. Already used internally to decide `this.<m>()` is numeric; exported
   * so the `+` lowering can too.
   */
  readonly numericFunctions: Set<string>;
  /**
   * (#3765) Does a reference to `name` at `node` resolve to a variable slot the
   * fixpoint proved numeric on **every definition**?
   *
   * Exported as a RESOLVER rather than a set because slot identity is
   * per-`(frame, name)`, not per-name: two different `c`s in two functions are
   * two slots with two verdicts, and a name-keyed export would silently merge
   * them. (`numericFunctions` gets away with name-keying only because it is
   * deliberately a whole-program property of the NAME.) The caller passes any
   * node inside the referencing scope and the same `ScopeTable` walk the
   * fixpoint itself used resolves it.
   *
   * This is the DEFINITION-site dual of #684's use-site inference: that pass
   * proves an f64 slot safe because every USE applies ToNumber, this one
   * because every DEFINITION already is a number. See `usageInferredLocalType`,
   * which is where the two meet.
   */
  readonly isNumericLocal: (node: ts.Node, name: string) => boolean;
  /**
   * Does the same scope-resolved binding have only provably-string
   * definitions? Unlike the numeric verdict this is consumed only as
   * interprocedural parameter evidence; it does not retype the local slot.
   */
  readonly isStringLocal: (node: ts.Node, name: string) => boolean;
}

/**
 * The compiler state updated by this subsystem's three carrier verdicts.
 *
 * Keeping application beside analysis prevents the module driver from growing
 * one assignment/feature-switch block per new carrier.
 */
export interface NumericPropertyAnalysisTarget {
  numericPropertyNames?: ReadonlySet<string>;
  stringPropertyNames?: ReadonlySet<string>;
  numericFunctionNames?: ReadonlySet<string>;
  /** Runtime eval can introduce calls and values outside the static source graph. */
  runtimeEvalCallableBoundaryEnabled?: boolean;
  /**
   * (#4122) The grounded slot verdict, exposed directly rather than only
   * through `usageInference`. `bindingHasMixedAssignmentCarrier` needs to ask
   * it BEFORE the carrier type exists, which is upstream of where
   * `usageInference` is consulted.
   */
  numericLocalVerdict?: PropertyKindVerdicts["isNumericLocal"];
  readonly usageInference: {
    setNumericLocalOracle(oracle: PropertyKindVerdicts["isNumericLocal"]): void;
  };
}

/** The verdict shape returned when the analysis declines to run at all. */
function noVerdicts(): PropertyKindVerdicts {
  return {
    numeric: new Set(),
    string: new Set(),
    numericFunctions: new Set(),
    isNumericLocal: () => false,
    isStringLocal: () => false,
  };
}

export function analyzeNumericPropertyNames(
  host: NumericPropertyAnalysisHost,
  sourceFiles: readonly ts.SourceFile[],
): PropertyKindVerdicts {
  // Kill-switch: `JS2WASM_NUMERIC_FIELDS=0` reproduces the pre-S4a field
  // shapes byte-for-byte on any program, which is what makes the twin/generic
  // and promoted/unpromoted differentials in the pin suite possible.
  if (process.env.JS2WASM_NUMERIC_FIELDS === "0") return noVerdicts();
  const scopes = buildScopes(sourceFiles);
  const facts = collectNumericFlowFacts(sourceFiles, scopes, host);
  if (facts.poisoned) {
    if (debugEnabled()) {
      process.stderr.write("[numeric-fields] POISONED: computed write/delete through a fnctor instance\n");
    }
    return noVerdicts();
  }
  // Seed parameter slots from their call sites, the same way #2847 does: a
  // parameter with no visible call site contributes one opaque definition (so
  // it is never "numeric", but IS still an opaque param read at a property
  // write — the trust boundary).
  for (const parameter of facts.parameters) {
    const before = parameter.slot.defs.length;
    if (parameter.initializer) parameter.slot.defs.push({ expr: parameter.initializer });
    for (const call of facts.calls.get(parameter.owner) ?? []) {
      const arg = call.args[parameter.index];
      parameter.slot.defs.push(arg ? { expr: arg, dynamicConflict: call.recursive } : {});
    }
    if (parameter.slot.defs.length === before) parameter.slot.defs.push({});
  }

  // (#3753 S1) AFTER the seeding above: the slot-aware string prover follows a
  // parameter to the arguments actually passed, which only exist once the
  // seeding loop has run. Before #3753 this ran earlier and was purely
  // syntactic, so the ordering did not matter — now it does.
  const stringProperties = collectStringProperties(facts, scopes);

  const numericSlots = new Set(scopes.allSlots());
  const numericFunctions = new Set(facts.functionsByName.keys());
  const writtenNames = new Set(facts.propertyWrites.map((write) => write.name));
  const numericProperties = new Set([...writtenNames].filter((name) => !facts.deletedNames.has(name)));

  const returnsByFunction = new Map<FunctionLike, ts.Expression[] | undefined>();
  for (const functions of facts.functionsByName.values()) {
    for (const fn of functions) returnsByFunction.set(fn, ownReturnExpressions(fn));
  }
  const writesByName = new Map<string, PropWrite[]>();
  for (const write of facts.propertyWrites) {
    const list = writesByName.get(write.name);
    if (list) list.push(write);
    else writesByName.set(write.name, [write]);
  }

  const sets: FixpointSets = { numericProperties, numericSlots, numericFunctions };
  const prover = makeProver(facts, host, stringProperties, sets);

  /** A single write is acceptable (numeric, forced-numeric, or opaque param). */
  const writeAcceptable = (write: PropWrite): boolean => {
    if (write.forcedNumeric) return true;
    if (write.value === undefined) return false;
    if (prover.isNumeric(write.value) || prover.isOpaqueParamRead(write.value)) return true;
    // `this.f += <opaque param>` — see {@link PropWrite.plusEqualsRhs}.
    return write.plusEqualsRhs !== undefined && prover.isOpaqueParamRead(write.plusEqualsRhs);
  };

  let changed = true;
  let safety = numericSlots.size + numericFunctions.size + numericProperties.size + 4;
  while (changed && safety-- > 0) {
    changed = false;
    for (const name of [...numericFunctions]) {
      const functions = facts.functionsByName.get(name) ?? [];
      const allNumeric =
        functions.length > 0 &&
        functions.every((fn) => {
          const returns = returnsByFunction.get(fn);
          return returns !== undefined && returns.every((expr) => prover.isNumeric(expr));
        });
      if (!allNumeric) {
        numericFunctions.delete(name);
        changed = true;
      }
    }
    for (const slot of [...numericSlots]) {
      const provesNumeric = (def: ValueDef): boolean =>
        def.forcedNumeric === true || (def.expr !== undefined && prover.isNumeric(def.expr));
      const provesNumericCarrier = (def: ValueDef): boolean =>
        provesNumeric(def) && (def.expr === undefined || !prover.isBooleanish(def.expr));
      const allNumeric =
        slot.defs.length > 0 &&
        (slot.isParam ? parameterDefinitionsAgree(slot, host, provesNumericCarrier) : slot.defs.every(provesNumeric));
      if (!allNumeric) {
        numericSlots.delete(slot);
        changed = true;
      }
    }
    for (const name of [...numericProperties]) {
      const ok = prover.withSelf(name, () => (writesByName.get(name) ?? []).every(writeAcceptable));
      if (!ok) {
        numericProperties.delete(name);
        changed = true;
      }
    }
  }

  // Groundedness: at least one write must be provably numeric while reads of
  // the name ITSELF count for nothing, so a slot that only ever recycles its
  // own value (`this.keyword = conf.keyword`) or is written solely through
  // opaque parameters is never promoted. And: a slot whose every write is a
  // BOOLEAN stays with #2847's boolean brand rather than becoming an f64.
  for (const name of [...numericProperties]) {
    const writes = writesByName.get(name) ?? [];
    const grounded = prover.withoutSelf(name, () =>
      writes.some(
        (write) => write.forcedNumeric === true || (write.value !== undefined && prover.isNumeric(write.value)),
      ),
    );
    // ANY boolean write, not just an all-boolean set: a mixed number/boolean
    // slot is exactly where the representation question is ambiguous, #2847 may
    // still brand it, and an unbranded f64 would make `node.flag === false`
    // answer `false` (JS says `true`). The hot tokenizer set has no boolean
    // writes at all, so this costs nothing where it matters.
    const anyBoolean =
      host.excludeNames?.has(name) === true ||
      writes.some((write) => write.value !== undefined && prover.isBooleanish(write.value));
    if (!grounded || anyBoolean) numericProperties.delete(name);
  }

  // (#3765) A GROUNDED slot set, for the one consumer that types a wasm local.
  //
  // `numericSlots` above is a GREATEST fixpoint: it starts with every slot
  // optimistically numeric and withdraws. That is right for its own consumer —
  // the property verdicts apply their own groundedness filter afterwards — but
  // it lets a pure CYCLE survive with no numeric evidence anywhere in it:
  //
  //     var a = b;   // `b` is in the set, so `a` stays
  //     var b = a;   // `a` is in the set, so `b` stays
  //
  // Both are `undefined` at runtime. Promoting either to an f64 local would
  // read `0`. So the local-typing consumer gets a LEAST fixpoint instead:
  // start empty and only ever ADD a slot whose every definition is provable
  // against slots ALREADY admitted. A cycle can never enter, because entering
  // it requires a member to already be in — which is the definition of
  // groundedness. The result is by construction a subset of `numericSlots`.
  const groundedSlots = new Set<Slot>();
  const groundedProver = makeProver(facts, host, stringProperties, {
    numericProperties,
    numericSlots: groundedSlots,
    numericFunctions,
  });
  const groundedCandidates = [...numericSlots];
  for (let pass = 0; pass <= groundedCandidates.length; pass++) {
    let added = false;
    for (const slot of groundedCandidates) {
      if (groundedSlots.has(slot)) continue;
      // ANY booleanish definition disqualifies the slot, mirroring the
      // `anyBoolean` filter on the property path — but for a STRICTER reason.
      // `isNumeric` deliberately answers true for booleans, which is fine for a
      // FIELD because #2847 brands boolean fields as i32 and the property path
      // defers to that brand. A local has no such brand path: an f64 local
      // holding a comparison result makes `` `${b}` `` print "1" where JS says
      // "true". Caught by `coercion/tostring > standalone-O > template over
      // any-boolean`.
      // (#4122) SELF-REFERENCE. The accumulator `var s = 0; s = s + f();` is the
      // most common numeric-local shape in ordinary JS, and a plain least
      // fixpoint can never admit it: proving `s` numeric requires `s` to be
      // numeric already. So assume the slot numeric while judging its OWN
      // definitions — the same induction `withSelf` gives the property path
      // ("if every other write stores a number then the slot always holds
      // one"), just for a lexical slot instead of a property name.
      groundedSlots.add(slot);
      let allNumeric: boolean;
      try {
        const provesNumeric = (def: ValueDef): boolean =>
          def.forcedNumeric === true || (def.expr !== undefined && groundedProver.isNumeric(def.expr));
        const provesNumericCarrier = (def: ValueDef): boolean =>
          provesNumeric(def) && (def.expr === undefined || !groundedProver.isBooleanish(def.expr));
        allNumeric =
          slot.defs.length > 0 &&
          (slot.isParam
            ? parameterDefinitionsAgree(slot, host, provesNumericCarrier)
            : slot.defs.every(provesNumeric)) &&
          !slot.defs.some((def) => def.expr !== undefined && groundedProver.isBooleanish(def.expr));
      } finally {
        groundedSlots.delete(slot);
      }
      if (!allNumeric) continue;
      // GROUNDEDNESS, re-checked with the assumption withdrawn: at least one
      // definition must be numeric on its own. Without this, `var s = s + 1;`
      // — whose only definition reads the slot before anything writes it — is
      // self-justifying, and an f64 carrier would read 0 where JS says NaN.
      // This is the slot analogue of the property path's `withoutSelf` pass,
      // and it is also what keeps a mutual cycle (`var a = b; var b = a;`) out:
      // the assumption covers a slot's own name, never its partner's.
      const grounded = slot.defs.some(
        (def) => def.forcedNumeric === true || (def.expr !== undefined && groundedProver.isNumeric(def.expr)),
      );
      if (grounded) {
        groundedSlots.add(slot);
        added = true;
      }
    }
    if (!added) break;
  }

  if (debugEnabled()) {
    process.stderr.write(
      `[numeric-fields] ${numericProperties.size}/${writtenNames.size} property names numeric: ` +
        `${[...numericProperties].sort().join(" ")}\n`,
    );
  }
  // `JS2WASM_NUMERIC_FIELDS_EXPLAIN=pos,start` — per-write verdicts for the
  // named properties. This is the tuning instrument: one demoting write
  // anywhere in a 230 KB module is otherwise invisible.
  const explain = process.env.JS2WASM_NUMERIC_FIELDS_EXPLAIN;
  if (explain) {
    for (const name of explain.split(",")) {
      const writes = writesByName.get(name) ?? [];
      process.stderr.write(
        `[numeric-fields] ${name}: ${numericProperties.has(name) ? "NUMERIC" : "rejected"} ` +
          `(${writes.length} writes${facts.deletedNames.has(name) ? ", DELETED" : ""}` +
          `${stringProperties.has(name) ? ", string-carrier" : ""})\n`,
      );
      prover.withSelf(name, () => {
        for (const write of writes) {
          const verdict = write.forcedNumeric
            ? "forced"
            : write.value === undefined
              ? "UNKNOWN"
              : prover.isNumeric(write.value)
                ? "numeric"
                : prover.isOpaqueParamRead(write.value)
                  ? "opaque-param"
                  : "REJECT";
          if (verdict !== "REJECT" && verdict !== "UNKNOWN" && process.env.JS2WASM_NUMERIC_FIELDS_EXPLAIN_ALL !== "1") {
            continue;
          }
          const text = write.value ? write.value.getText().slice(0, 72).replace(/\s+/g, " ") : "<none>";
          process.stderr.write(`[numeric-fields]    ${verdict.padEnd(12)} ${text}\n`);
        }
      });
    }
  }
  return {
    numeric: numericProperties,
    string: stringProperties,
    numericFunctions,
    // Resolved through the SAME `ScopeTable` the fixpoint used, so a caller
    // cannot accidentally consult a different (looser) notion of scope.
    isNumericLocal: (node, name) => {
      const slot = scopes.resolve(node, name);
      return slot !== undefined && groundedSlots.has(slot);
    },
    isStringLocal: (node, name) => {
      const slot = scopes.resolve(node, name);
      return (
        slot !== undefined &&
        slot.defs.length > 0 &&
        slot.defs.every((def) => def.expr !== undefined && prover.isString(def.expr))
      );
    },
  };
}

/**
 * Run the whole-program analysis and apply every carrier verdict together.
 *
 * The local kill switch only withholds the local oracle. Field, string, and
 * return verdicts remain installed because they have independent switches and
 * predate #3765.
 */
export function applyNumericPropertyAnalysis(
  target: NumericPropertyAnalysisTarget,
  host: NumericPropertyAnalysisHost,
  sourceFiles: readonly ts.SourceFile[],
): void {
  const verdicts = analyzeNumericPropertyNames(host, sourceFiles);
  target.numericPropertyNames = verdicts.numeric;
  target.stringPropertyNames = verdicts.string;
  target.numericFunctionNames = verdicts.numericFunctions;
  // Runtime-eval modules are not closed worlds: interpreted callables can feed
  // values through AOT functions without a statically visible call site. The
  // parameter fixpoint may still derive field/return facts, but its local
  // carrier oracle must not narrow those dynamically reached bindings.
  if (process.env.JS2WASM_NUMERIC_LOCALS !== "0" && target.runtimeEvalCallableBoundaryEnabled !== true) {
    target.usageInference.setNumericLocalOracle(verdicts.isNumericLocal);
    target.numericLocalVerdict = verdicts.isNumericLocal;
  }
}

/**
 * (#4121 slice 2) Re-run the local carrier verdict once the declaration-resolved
 * return carriers are known, and reinstall it.
 *
 * The two analyses are STRATIFIED, not mutually recursive:
 * `inferBindingAwareNumericReturnTypes` reads the local verdict this module
 * produces, so it cannot run first; its result is therefore new evidence that
 * only a SECOND pass can consume. Nothing here feeds back into the return map,
 * so there is no cycle to launder a carrier through — level 1 (locals) grounds
 * level 2 (returns), and level 2 grounds this level-3 refinement.
 *
 * Only the LOCAL verdict is republished. Field and string verdicts keep their
 * first-pass values: those decide struct shapes and parameter ABIs that other
 * passes have already read by this point, and this slice's evidence is about
 * a local's carrier, not a field's.
 *
 * `callEvidence === undefined` means the first pass already knew everything the
 * return map could tell it, so no second pass runs and the output is
 * byte-identical.
 */
export function refineNumericLocalsWithCallReturns(
  target: NumericPropertyAnalysisTarget,
  host: NumericPropertyAnalysisHost,
  sourceFiles: readonly ts.SourceFile[],
  callEvidence: ((call: ts.CallExpression) => boolean) | undefined,
): boolean {
  if (callEvidence === undefined) return false;
  if (process.env.JS2WASM_NUMERIC_LOCALS === "0" || target.runtimeEvalCallableBoundaryEnabled === true) return false;
  const refined = analyzeNumericPropertyNames({ ...host, provenNumericCallReturn: callEvidence }, sourceFiles);
  target.usageInference.setNumericLocalOracle(refined.isNumericLocal);
  target.numericLocalVerdict = refined.isNumericLocal;
  return true;
}
