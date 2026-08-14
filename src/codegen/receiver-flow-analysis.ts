// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3685 S1 — receiver-flow analysis: which expressions provably denote an
 * instance of exactly ONE approved fnctor class.
 *
 * ## Why this exists
 *
 * #3683 monomorphized `this.<field>` reads and `this.<m>()` calls inside a
 * typed twin: the receiver is known to be `$__fnctor_F`, so a read is a bare
 * `struct.get` (of an f64 slot, after #3683 S4a) and a call is a direct
 * `call`. Measured on compiled acorn, the call half alone took ~20 % off the
 * parse (#3673 round 26).
 *
 * The mechanism stops at the literal `this.` prefix. The #3673 round-26
 * profile shows the cost of that: `__extern_get` is 8.8 % of deep-warm parse
 * time, and its callers are receivers that are NOT `this` —
 * `parser.options.locations` (once per AST node, out of acorn's `Node`
 * constructor), `node.start`, `state.pos`. Each is a call returning a boxed
 * value where the `this.` spelling of the same field is a struct load.
 *
 * This module supplies the missing half: the PROOF. It answers, for a given
 * expression, "is this an instance of exactly one approved fnctor class?".
 * The lowering it feeds already exists (#3683's typed-this emitters), which is
 * why this ships inert first — the same analysis-before-wiring discipline that
 * `numeric-property-analysis.ts` (#3683 S4a) and `user-method-names.ts`
 * (#3673 round 28) used successfully.
 *
 * ## Proof sources (all STATIC and conservative; unproven ⇒ no verdict)
 *
 *   1. `new F(...)` flowing into a `const`/never-reassigned `let` binding.
 *   2. A PARAMETER whose every call site in the program passes a value that is
 *      itself proven — acorn's `new Node(parser, …)` is the motivating case:
 *      every call passes `this` from inside a Parser method.
 *   3. `this` inside a method of an approved class (subsumes #3683's case as
 *      the degenerate one, so a future unification has a single entry point).
 *
 * Deliberately NOT proof sources (recorded so a later slice doesn't have to
 * re-derive why): a field read (needs the slot's declared type, which is a
 * codegen-time fact this AST-level pass does not have), any binding that is
 * ever assigned from a call result, and anything reachable from a computed
 * write. A false NEGATIVE costs one dynamic access — a false POSITIVE is a
 * wrong `ref.cast` and a trap, so every rule here fails closed.
 *
 * ## Invalidation
 *
 * A binding is DEMOTED (verdict withdrawn) when it is ever:
 *   - assigned a second time from a non-`new F` expression,
 *   - the operand of a `delete`,
 *   - captured by a nested function that assigns it,
 *   - passed to a parameter position that another proof relies on, with a
 *     conflicting class.
 * Demotion is monotonic: the analysis runs to a fixed point, and once a name
 * is demoted it never re-promotes.
 */
import ts from "typescript";

import { optInFlagEnabled } from "../perf-flags.js";

/**
 * (#4405) `JS2WASM_RECEIVER_SPEC` — receiver-type specialisation for NON-`this`
 * receivers. Default **OFF**; with it unset this module behaves exactly as it
 * did before #4405 Phase 1, which is what makes the byte-identity check
 * meaningful. Off-tokens are the shared `perf-flags` family's.
 *
 * Read per call rather than cached in a module constant so a test can flip it
 * between compiles in one process.
 */
export function receiverSpecEnabled(): boolean {
  return optInFlagEnabled(process.env.JS2WASM_RECEIVER_SPEC);
}

/** A per-binding or per-parameter verdict: the single class it always holds. */
export interface ReceiverVerdict {
  /** The approved fnctor class name (matches `ctx.structMap` key `__fnctor_<name>`). */
  readonly className: string;
  /** Which rule established it — for the debug tally and for slice gating. */
  readonly source: "new-binding" | "call-return" | "parameter" | "this";
}

export interface ReceiverFlowResult {
  /**
   * Verdicts keyed by the DECLARATION node the binding resolves to
   * (`ts.VariableDeclaration` | `ts.ParameterDeclaration`). Keying by node —
   * not by name — keeps shadowed names in different scopes distinct without
   * this pass having to build a scope chain.
   */
  readonly byDeclaration: ReadonlyMap<ts.Node, ReceiverVerdict>;
  /** Names demoted at least once (diagnostics only). */
  readonly demoted: ReadonlySet<string>;
  /** Per-source admitted counts, for the `JS2WASM_RECEIVER_FLOW_DEBUG` tally. */
  readonly tally: Readonly<Record<ReceiverVerdict["source"], number>>;
}

const EMPTY: ReceiverFlowResult = {
  byDeclaration: new Map(),
  demoted: new Set(),
  tally: { "new-binding": 0, "call-return": 0, parameter: 0, this: 0 },
};

/** The class name of a `new F(...)` expression whose callee is a plain identifier. */
function newExpressionClassName(expr: ts.Expression | undefined): string | undefined {
  if (!expr || !ts.isNewExpression(expr)) return undefined;
  return ts.isIdentifier(expr.expression) ? expr.expression.text : undefined;
}

/** Is this declaration a single-assignment binding (`const`, or a `let` never reassigned)? */
function isConstLike(decl: ts.VariableDeclaration): boolean {
  const list = decl.parent;
  if (!ts.isVariableDeclarationList(list)) return false;
  return (list.flags & ts.NodeFlags.Const) !== 0;
}

/**
 * Resolve an identifier to the declaration it reads, using ONLY the syntactic
 * information available here: a walk out through enclosing scopes looking for a
 * variable/parameter declaration of that name. Returns undefined when the name
 * is not found, is declared more than once on the path (ambiguous), or resolves
 * to something this pass does not model.
 *
 * This is intentionally weaker than the checker's resolver. It cannot be wrong
 * in the unsafe direction: an unresolved or ambiguous name yields no verdict.
 */
function resolveLocalBinding(id: ts.Identifier): ts.Node | undefined {
  return resolveLocalBindingWithReason(id).decl;
}

/**
 * (#4405 Phase 0) The same walk, reporting WHY it failed. Split out so the
 * census can distinguish "the name is declared twice on the path" from "no
 * declaration found at all" — the two have completely different fixes, and the
 * #4405 spec names the first as a prime suspect. Behaviour is byte-identical:
 * {@link resolveLocalBinding} is this function's `.decl`.
 */
function resolveLocalBindingWithReason(id: ts.Identifier): {
  decl: ts.Node | undefined;
  reason: "found" | "ambiguous" | "not-found";
} {
  const name = id.text;
  let found: ts.Node | undefined;
  let scope: ts.Node | undefined = id.parent;
  while (scope) {
    const container = scope;
    let hitsInThisScope = 0;
    const scan = (node: ts.Node): void => {
      // Do not descend into nested functions — their locals are a different scope.
      if (
        node !== container &&
        (ts.isFunctionDeclaration(node) ||
          ts.isFunctionExpression(node) ||
          ts.isArrowFunction(node) ||
          ts.isMethodDeclaration(node))
      ) {
        return;
      }
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
        hitsInThisScope++;
        found ??= node;
      }
      if (ts.isParameter(node) && ts.isIdentifier(node.name) && node.name.text === name) {
        hitsInThisScope++;
        found ??= node;
      }
      ts.forEachChild(node, scan);
    };
    scan(container);
    if (hitsInThisScope > 1) return { decl: undefined, reason: "ambiguous" }; // fail closed
    if (found) return { decl: found, reason: "found" };
    scope = scope.parent;
  }
  return { decl: undefined, reason: "not-found" };
}

/**
 * Pass 1 — `new F(...)` bindings. A `var p = new Parser(...)` binding holds a
 * Parser unless something later writes it.
 *
 * `const` AND `var`/`let` are admitted: real prototype-style JS (acorn's dist
 * is ES5, `var` everywhere) never uses `const`, and restricting to it admitted
 * ZERO bindings. Safety comes from pass 3, which WITHDRAWS any binding written
 * after its initializer — so an admitted `var` is one the whole file never
 * reassigns, which is the property this rule actually needs. {@link isConstLike}
 * is kept as the fast path for the common case.
 */
function collectNewBindings(
  sourceFile: ts.SourceFile,
  approvedClasses: ReadonlySet<string>,
  byDeclaration: Map<ts.Node, ReceiverVerdict>,
): void {
  const walk = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const cls = newExpressionClassName(node.initializer);
      if (cls !== undefined && approvedClasses.has(cls)) {
        void isConstLike(node);
        byDeclaration.set(node, { className: cls, source: "new-binding" });
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(sourceFile);
}

/**
 * Pass 1b — prototype ALIAS map.
 *
 * Real-world prototype-style JS almost never writes `F.prototype.m = …`
 * directly: acorn's dist has `var pp$8 = Parser.prototype;` and then
 * `pp$8.parseTopLevel = function (node) { … }`, with NINE such aliases. The
 * first tally of this analysis over real acorn admitted ZERO receivers for
 * exactly this reason — the unit tests used the direct form, the shipping code
 * does not.
 */
function collectPrototypeAliases(sourceFile: ts.SourceFile, approvedClasses: ReadonlySet<string>): Map<string, string> {
  const prototypeAlias = new Map<string, string>();
  const walk = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const init = node.initializer;
      if (
        ts.isPropertyAccessExpression(init) &&
        init.name.text === "prototype" &&
        ts.isIdentifier(init.expression) &&
        approvedClasses.has(init.expression.text)
      ) {
        const existing = prototypeAlias.get(node.name.text);
        // An alias bound twice to DIFFERENT classes is ambiguous — drop it.
        if (existing !== undefined && existing !== init.expression.text) prototypeAlias.delete(node.name.text);
        else prototypeAlias.set(node.name.text, init.expression.text);
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(sourceFile);
  return prototypeAlias;
}

/**
 * Pass 1c — prototype METHOD map, keyed `${class}.${method}`.
 *
 * The first alias-aware tally admitted only 20 of acorn's 2,363 non-`this`
 * property accesses, because its dominant shape is a PARAMETER fed from a CALL
 * result: `pp.finishNode = function (node, type) { … node.start … }` receives
 * what `this.startNode()` returned, and `pp.startNode = function () { return new
 * Node(this, …) }`. Without a return-class rule every such argument is
 * "unproven" and the parameter rule refuses.
 */
function collectPrototypeMethods(
  sourceFile: ts.SourceFile,
  approvedClasses: ReadonlySet<string>,
  prototypeAlias: ReadonlyMap<string, string>,
): Map<string, ts.FunctionExpression> {
  const methodBodies = new Map<string, ts.FunctionExpression>();
  const walk = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const lhs = node.left;
      if (ts.isPropertyAccessExpression(lhs) && ts.isFunctionExpression(node.right)) {
        let cls: string | undefined;
        if (ts.isIdentifier(lhs.expression)) cls = prototypeAlias.get(lhs.expression.text);
        else if (
          ts.isPropertyAccessExpression(lhs.expression) &&
          lhs.expression.name.text === "prototype" &&
          ts.isIdentifier(lhs.expression.expression) &&
          approvedClasses.has(lhs.expression.expression.text)
        ) {
          cls = lhs.expression.expression.text;
        }
        if (cls !== undefined) methodBodies.set(`${cls}.${lhs.name.text}`, node.right);
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(sourceFile);
  return methodBodies;
}

/** Class returned by every `return` in `fn`, when they agree and none is bare. */
function inferReturnClass(
  fn: ts.FunctionExpression | ts.FunctionDeclaration,
  argClass: (e: ts.Expression, enclosing: string | undefined) => string | undefined,
  enclosing: string | undefined,
): string | undefined {
  const seen = new Set<string>();
  let bare = false;
  let any = false;
  const walk = (node: ts.Node): void => {
    // Do not descend into nested functions — their returns are not ours.
    if (node !== fn && (ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node) || ts.isArrowFunction(node))) {
      return;
    }
    if (ts.isReturnStatement(node)) {
      any = true;
      if (!node.expression) {
        bare = true;
        return;
      }
      const cls = argClass(node.expression, enclosing);
      if (cls === undefined) bare = true;
      else seen.add(cls);
    }
    ts.forEachChild(node, walk);
  };
  walk(fn);
  // A function that can fall off the end returns undefined on that path.
  if (!any || bare || seen.size !== 1) return undefined;
  return [...seen][0];
}

/**
 * The approved class whose prototype method / constructor body `node` sits
 * inside, so `this` in that body has a known class. Recognizes both shapes
 * acorn uses: `F.prototype.m = function () {}` and `pp.m = function () {}`
 * where `pp = F.prototype` (pass 1b).
 */
function enclosingThisClassOf(
  node: ts.Node,
  approvedClasses: ReadonlySet<string>,
  prototypeAlias: ReadonlyMap<string, string>,
): string | undefined {
  let cur: ts.Node | undefined = node;
  while (cur) {
    if (ts.isFunctionExpression(cur) || ts.isFunctionDeclaration(cur)) {
      const parent: ts.Node | undefined = cur.parent;
      if (parent && ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const lhs = parent.left;
        if (ts.isPropertyAccessExpression(lhs)) {
          // `F.prototype.m = function () {}`
          if (ts.isPropertyAccessExpression(lhs.expression)) {
            const base = lhs.expression;
            if (base.name.text === "prototype" && ts.isIdentifier(base.expression)) {
              const cls = base.expression.text;
              if (approvedClasses.has(cls)) return cls;
            }
          }
          // `pp$8.m = function () {}` where `var pp$8 = F.prototype` (pass 1b)
          if (ts.isIdentifier(lhs.expression)) {
            const viaAlias = prototypeAlias.get(lhs.expression.text);
            if (viaAlias !== undefined) return viaAlias;
          }
        }
      }
      // `function F(...) { this.x = … }` — the constructor itself.
      if (cur.name && approvedClasses.has(cur.name.text)) return cur.name.text;
      // A `var F = function F(...)` constructor binding.
      if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
        const cls = parent.name.text;
        if (approvedClasses.has(cls)) return cls;
      }
      return undefined; // a non-method function resets `this`
    }
    if (ts.isArrowFunction(cur)) {
      cur = cur.parent; // arrows inherit `this`
      continue;
    }
    cur = cur.parent;
  }
  return undefined;
}

/** (#4405 Phase 1) method NAME → every class that declares a method of that name. */
function buildMethodNameOwners(methodBodies: ReadonlyMap<string, ts.FunctionExpression>): Map<string, Set<string>> {
  const owners = new Map<string, Set<string>>();
  for (const key of methodBodies.keys()) {
    const dot = key.lastIndexOf(".");
    const name = key.slice(dot + 1);
    let set = owners.get(name);
    if (set === undefined) {
      set = new Set<string>();
      owners.set(name, set);
    }
    set.add(key.slice(0, dot));
  }
  return owners;
}

/**
 * (#4405 Phase 1) Poison every method whose slot ESCAPES callee position.
 *
 * `pp.parseStatement.call(this, node)`, `[pp.a, pp.b]`, `f(pp.parseIdent)`: each
 * can reach the body with arguments this pass never inspects, which would make
 * pass 2's "every call site agrees" claim false. Only the defining assignment
 * (`pp.m = function () {}`, pass 1c's own shape) and a direct callee position
 * are safe.
 */
function poisonEscapingMethodSlots(
  sourceFile: ts.SourceFile,
  methodNameOwners: ReadonlyMap<string, ReadonlySet<string>>,
  poison: (name: string) => void,
): void {
  const walk = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && methodNameOwners.has(node.name.text)) {
      const parent: ts.Node | undefined = node.parent;
      const isCallee = parent !== undefined && ts.isCallExpression(parent) && parent.expression === node;
      const isDefiningWrite =
        parent !== undefined &&
        ts.isBinaryExpression(parent) &&
        parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        parent.left === node;
      if (!isCallee && !isDefiningWrite) poison(node.name.text);
    }
    ts.forEachChild(node, walk);
  };
  walk(sourceFile);
}

/**
 * Pass 3 — demote anything ever written or deleted. A verdict says "this
 * binding ALWAYS holds an instance of F"; any write after the initializer, or a
 * `delete`, breaks that. Monotonic: once removed, never restored.
 */
function demoteWrittenBindings(
  sourceFile: ts.SourceFile,
  byDeclaration: Map<ts.Node, ReceiverVerdict>,
  demoted: Set<string>,
): void {
  const walk = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const lhs = node.left;
      if (ts.isIdentifier(lhs)) {
        const decl = resolveLocalBinding(lhs);
        if (decl && byDeclaration.has(decl)) {
          const cls = newExpressionClassName(node.right);
          if (cls === undefined || cls !== byDeclaration.get(decl)!.className) {
            byDeclaration.delete(decl);
            demoted.add(lhs.text);
          }
        }
      }
    }
    if (ts.isDeleteExpression(node) && ts.isIdentifier(node.expression)) {
      const decl = resolveLocalBinding(node.expression);
      if (decl && byDeclaration.delete(decl)) demoted.add(node.expression.text);
    }
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && ts.isIdentifier(node.operand)) {
      const decl = resolveLocalBinding(node.operand);
      if (decl && byDeclaration.delete(decl)) demoted.add(node.operand.text);
    }
    ts.forEachChild(node, walk);
  };
  walk(sourceFile);
}

/**
 * Run the receiver-flow analysis over one source file.
 *
 * `approvedClasses` is the fnctor escape gate's approved-name set: a class the
 * gate rejected has no `$__fnctor_<name>` struct, so proving a receiver is an
 * instance of it buys nothing and must not be recorded.
 */
export function analyzeReceiverFlow(
  sourceFile: ts.SourceFile,
  approvedClasses: ReadonlySet<string>,
): ReceiverFlowResult {
  if (approvedClasses.size === 0) return EMPTY;

  const specEnabled = receiverSpecEnabled(); // (#4405) read once per analysis
  const byDeclaration = new Map<ts.Node, ReceiverVerdict>();
  const demoted = new Set<string>();

  // Passes 1 / 1b / 1c — see each collector's own doc comment.
  collectNewBindings(sourceFile, approvedClasses, byDeclaration);
  const prototypeAlias = collectPrototypeAliases(sourceFile, approvedClasses);
  const methodBodies = collectPrototypeMethods(sourceFile, approvedClasses, prototypeAlias);

  /** Class returned by every `return` in a method body, once inferable. */
  const returnClassOf = new Map<ts.Node, string>();

  // ── Pass 2: parameters whose every call site passes a proven value ────────
  // Motivating case: acorn's `var Node = function Node(parser, pos, loc) { …
  // parser.options.locations … }` — every construction passes `this` from
  // inside a Parser method, so `parser` is always a Parser.
  //
  // Collect, per (function declaration, parameter index), the set of classes
  // observed across ALL call sites. A parameter is admitted only when the set
  // is a singleton AND no call site was unproven — one unknown argument makes
  // the parameter unknown.
  interface ParamObservation {
    classes: Set<string>;
    unproven: boolean;
  }
  const observations = new Map<ts.Node, ParamObservation[]>();

  /** The class an ARGUMENT expression provably denotes, if any. */
  const argumentClass = (arg: ts.Expression, enclosingClass: string | undefined): string | undefined => {
    if (arg.kind === ts.SyntaxKind.ThisKeyword) return enclosingClass;
    const direct = newExpressionClassName(arg);
    if (direct !== undefined && approvedClasses.has(direct)) return direct;
    if (ts.isIdentifier(arg)) {
      const decl = resolveLocalBinding(arg);
      const verdict = decl ? byDeclaration.get(decl) : undefined;
      return verdict?.className;
    }
    // (pass 1c) `this.m()` / `p.m()` whose method has an inferred return class.
    if (ts.isCallExpression(arg) && ts.isPropertyAccessExpression(arg.expression)) {
      const recvCls = argumentClass(arg.expression.expression, enclosingClass);
      if (recvCls !== undefined) {
        const body = methodBodies.get(`${recvCls}.${arg.expression.name.text}`);
        if (body !== undefined) return returnClassOf.get(body);
      }
    }
    return undefined;
  };

  const enclosingThisClass = (node: ts.Node): string | undefined =>
    enclosingThisClassOf(node, approvedClasses, prototypeAlias);

  // (#4405 Phase 1) method NAME → the classes that declare it. Needed twice
  // below: to route a `recv.m(…)` call site to the right body, and to POISON
  // every same-named body when a call site's receiver is unprovable.
  const methodNameOwners = buildMethodNameOwners(methodBodies);

  /**
   * (#4405 Phase 1) Bodies whose parameter observations cannot be trusted.
   *
   * Pass 2's rule is "every call site passes the same proven class", so it is
   * only sound while we can SEE every call site. A prototype method reached
   * through a receiver we cannot classify — `foo.parseStatement(x)` with `foo`
   * unproven, or `pp.parseStatement.call(that, x)`, or the slot passed around as
   * a value — is a call site whose argument we never looked at. Rather than
   * trust the guard to clean that up, poison the body: no verdict at all for its
   * parameters.
   */
  const poisonedBodies = new Set<ts.Node>();
  const poisonMethodName = (name: string): void => {
    for (const cls of methodNameOwners.get(name) ?? []) {
      const body = methodBodies.get(`${cls}.${name}`);
      if (body !== undefined) poisonedBodies.add(body);
    }
  };

  /**
   * The callee's declaration, when the call target is a locally-declared
   * function OR — (#4405 Phase 1) — a prototype method reached through a
   * receiver whose class is proven.
   *
   * ## Why the property-access half exists
   *
   * Measured (#4405 Phase 0 census, standalone acorn): **1,240 of 3,244
   * identifier receivers the analysis refused were `no-verdict:param`**, led by
   * `state` 434, `node` 243, `prop` 120, `expr` 112 — precisely the receivers
   * the issue targets. They were not being *rejected*: with this function
   * bailing on any non-identifier callee, every `this.parseStatement(node)` site
   * was invisible, so prototype-method parameters were never OBSERVED and the
   * verdict loop (which iterates `observations`) never saw them at all.
   *
   * Pass 1c already built `methodBodies`; this just uses it on the call side.
   */
  const calleeDeclaration = (
    call: ts.CallExpression | ts.NewExpression,
    enclosing: string | undefined,
  ): ts.Node | undefined => {
    const callee = call.expression;
    if (ts.isPropertyAccessExpression(callee)) {
      if (!specEnabled) return undefined; // (#4405) flag off ⇒ pre-Phase-1 behaviour
      const name = callee.name.text;
      if (!methodNameOwners.has(name)) return undefined;
      // ROUND-INDEPENDENT receiver classification only — see the note on the
      // fixed point below. `this` inside a known method body and a literal
      // `new F()` are both decided before the loop starts and never revised, so
      // the set of observed call sites is FIXED across rounds. That is what
      // makes the fixed point a least one: an argument can only go
      // unproven→proven, never the reverse, so an admitted parameter stays
      // admitted. Classifying the receiver through `argumentClass` instead
      // would let a call site become visible in round 3 and retract a verdict
      // granted in round 1.
      const recvCls =
        callee.expression.kind === ts.SyntaxKind.ThisKeyword ? enclosing : newExpressionClassName(callee.expression);
      if (recvCls === undefined || !approvedClasses.has(recvCls)) {
        // An unclassifiable receiver MIGHT be an instance of the owning class,
        // which would make this an unobserved call site. Fail closed.
        poisonMethodName(name);
        return undefined;
      }
      return methodBodies.get(`${recvCls}.${name}`);
    }
    if (!ts.isIdentifier(callee)) return undefined;
    const decl = resolveLocalBinding(callee);
    if (decl && ts.isVariableDeclaration(decl) && decl.initializer) {
      if (ts.isFunctionExpression(decl.initializer)) return decl.initializer;
    }
    // A top-level `function F(...) {}` declaration.
    let found: ts.Node | undefined;
    const scan = (node: ts.Node): void => {
      if (found) return;
      if (ts.isFunctionDeclaration(node) && node.name?.text === callee.text) found = node;
      ts.forEachChild(node, scan);
    };
    scan(sourceFile);
    return found;
  };

  // (#4405 Phase 1) Poison methods whose slot escapes callee position.
  if (specEnabled) poisonEscapingMethodSlots(sourceFile, methodNameOwners, poisonMethodName);

  // ── Pass 1d: bindings initialized from a call with an inferred return class ─
  // acorn's `var node = this.startNode()` — the shape that feeds every
  // `finishNode(node, …)`. Runs after the return fixed point; pass 3 still
  // withdraws anything reassigned.
  const collectCallBindings = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      !byDeclaration.has(node)
    ) {
      const enclosing = enclosingThisClass(node);
      const cls = argumentClass(node.initializer, enclosing);
      if (cls !== undefined) byDeclaration.set(node, { className: cls, source: "call-return" });
    }
    ts.forEachChild(node, collectCallBindings);
  };

  const collectCallSites = (node: ts.Node): void => {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const enclosing = enclosingThisClass(node);
      const decl = calleeDeclaration(node, enclosing);
      const params =
        decl && (ts.isFunctionExpression(decl) || ts.isFunctionDeclaration(decl)) ? decl.parameters : undefined;
      if (decl && params) {
        let obs = observations.get(decl);
        if (!obs) {
          obs = params.map(() => ({ classes: new Set<string>(), unproven: false }));
          observations.set(decl, obs);
        }
        const args = node.arguments ?? ts.factory.createNodeArray([]);
        for (let i = 0; i < obs.length; i++) {
          const arg = args[i];
          if (arg === undefined) {
            obs[i]!.unproven = true; // omitted ⇒ undefined ⇒ not an instance
            continue;
          }
          const cls = argumentClass(arg, enclosing);
          if (cls === undefined) obs[i]!.unproven = true;
          else obs[i]!.classes.add(cls);
        }
      }
    }
    ts.forEachChild(node, collectCallSites);
  };

  // ── (#4405 Phase 1) One fixed point over 1c + 1d + 2, not three sequential
  // passes ──────────────────────────────────────────────────────────────────
  // The three feed each other and acorn chains them several deep: a PARAMETER
  // verdict (`pp.finishNode = function (node, …)`) makes `node` a provable
  // ARGUMENT at the next call site, which makes another parameter provable, and
  // a provable receiver makes another method's RETURN class inferable, which
  // makes another `var x = this.m()` binding provable. Running each pass once
  // stops at the first link.
  //
  // Monotone by construction — every step only ADDS to `byDeclaration` /
  // `returnClassOf`, and `argumentClass` is monotone in both — so the loop
  // terminates and the order of the three within a round does not change the
  // fixed point, only how fast it is reached. Rounds are capped because the
  // walks are whole-file; 4 is comfortably past acorn's deepest chain
  // (startNode → finishNode → parseX → parseSubscripts).
  //
  // Parameter DEMOTIONS are collected per round and merged only at the end: a
  // parameter unproven in round 1 is routinely proven in round 2, and recording
  // the intermediate state would make `demoted` (diagnostics) lie.
  //
  // With the flag OFF the loop runs exactly ONE round, which is the original
  // "returns fixed point (3 inner rounds), then 1d, then 2, then the verdict
  // loop" sequence unchanged — that is what keeps flag-off byte-identical.
  const paramDemotions = new Set<string>();
  for (let round = 0; round < (specEnabled ? 4 : 1); round++) {
    const before = byDeclaration.size + returnClassOf.size;
    paramDemotions.clear();

    // Inner fixed point over return classes (monotone; 3 rounds is ample —
    // acorn's deepest chain is startNode → finishNode → parse*). It breaks out
    // as soon as nothing changed, so re-entering it per outer round is free.
    for (let inner = 0; inner < 3; inner++) {
      let changed = false;
      for (const [key, body] of methodBodies) {
        if (returnClassOf.has(body)) continue;
        const cls = inferReturnClass(body, argumentClass, key.slice(0, key.lastIndexOf(".")));
        if (cls !== undefined) {
          returnClassOf.set(body, cls);
          changed = true;
        }
      }
      if (!changed) break;
    }

    collectCallBindings(sourceFile);

    observations.clear();
    collectCallSites(sourceFile);

    for (const [decl, obs] of observations) {
      if (poisonedBodies.has(decl)) continue; // an unobserved call site exists
      const params = (decl as ts.FunctionLikeDeclaration).parameters;
      for (let i = 0; i < obs.length; i++) {
        const o = obs[i]!;
        const param = params[i];
        if (!param || !ts.isIdentifier(param.name)) continue;
        if (o.unproven || o.classes.size !== 1) {
          if (o.classes.size > 0) paramDemotions.add(param.name.text);
          continue;
        }
        // A parameter with a default or a rest parameter can hold something else.
        if (param.initializer !== undefined || param.dotDotDotToken !== undefined) {
          paramDemotions.add(param.name.text);
          continue;
        }
        const cls = [...o.classes][0]!;
        byDeclaration.set(param, { className: cls, source: "parameter" });
      }
    }

    if (byDeclaration.size + returnClassOf.size === before) break;
  }
  for (const name of paramDemotions) demoted.add(name);

  // Pass 3 — see {@link demoteWrittenBindings}.
  demoteWrittenBindings(sourceFile, byDeclaration, demoted);

  const tally: Record<ReceiverVerdict["source"], number> = {
    "new-binding": 0,
    "call-return": 0,
    parameter: 0,
    this: 0,
  };
  for (const v of byDeclaration.values()) tally[v.source]++;

  return { byDeclaration, demoted, tally };
}

/**
 * Resolve the class of a RECEIVER expression against a computed result — the
 * entry point a lowering slice (#3685 S2/S3) will call at each member-access
 * site. `enclosingClass` is the class whose method body the access sits in,
 * when known (the `this` proof source).
 */
export function receiverClassOf(
  result: ReceiverFlowResult,
  receiver: ts.Expression,
  enclosingClass: string | undefined,
): string | undefined {
  if (receiver.kind === ts.SyntaxKind.ThisKeyword) return enclosingClass;
  if (ts.isIdentifier(receiver)) {
    const decl = resolveLocalBinding(receiver);
    if (decl) return result.byDeclaration.get(decl)?.className;
  }
  return undefined;
}

/**
 * (#4405 Phase 0) Diagnosis-only: WHY did {@link receiverClassOf} decline?
 *
 * This exists because the #4405 spec's first instruction for Phase 1 is
 * "instrument which pass drops `node` / `state` / `prop` / `expr`, do not
 * guess". The reasons it distinguishes are exactly the ones with different
 * fixes:
 *
 *  - `ambiguous` — {@link resolveLocalBindingWithReason} saw the name declared
 *    twice on the path and failed closed. Fix: a real scope chain.
 *  - `not-found` — no declaration at all on the syntactic path.
 *  - `no-verdict:var-noinit` — the binding is declared bare (`var node;`) and
 *    assigned later, so pass 1d's "initializer is syntactically a
 *    `CallExpression`" precondition can never hold. Fix: an assignment-shaped
 *    rule.
 *  - `no-verdict:var-init:<kind>` — pass 1/1d SAW the initializer and still
 *    produced nothing; the kind says which rule to strengthen.
 *  - `no-verdict:param` — pass 2 refused the parameter (one unproven call site
 *    is enough).
 *
 * Never called on a shipping compile — the caller gates it behind the census
 * env var. Returns a low-cardinality string suitable for a histogram key.
 */
export function explainReceiverDecline(result: ReceiverFlowResult, receiver: ts.Identifier): string {
  const { decl, reason } = resolveLocalBindingWithReason(receiver);
  if (reason !== "found" || decl === undefined) {
    return result.demoted.has(receiver.text) ? `${reason}+demoted` : reason;
  }
  if (ts.isParameter(decl)) return "no-verdict:param";
  if (ts.isVariableDeclaration(decl)) {
    if (decl.initializer === undefined) return "no-verdict:var-noinit";
    return `no-verdict:var-init:${ts.SyntaxKind[decl.initializer.kind]}`;
  }
  return "no-verdict:other";
}
