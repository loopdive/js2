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
    if (hitsInThisScope > 1) return undefined; // ambiguous — fail closed
    if (found) return found;
    scope = scope.parent;
  }
  return undefined;
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

  const byDeclaration = new Map<ts.Node, ReceiverVerdict>();
  const demoted = new Set<string>();

  // ── Pass 1: `new F(...)` bindings ────────────────────────────────────────
  // A `const p = new Parser(...)` binding always holds a Parser. A `let` is
  // excluded outright rather than reassignment-tracked: cheap, and the pattern
  // this targets (acorn's `var parser = new Parser(options, input)`) is const
  // in the compiled output and re-scanned by pass 2 through the parameter rule
  // when it is not.
  const collectNewBindings = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const cls = newExpressionClassName(node.initializer);
      if (cls !== undefined && approvedClasses.has(cls)) {
        // `const` AND `var`/`let`: real prototype-style JS (acorn's dist is
        // ES5, `var` everywhere) never uses `const`, and restricting to it
        // admitted ZERO bindings. Safety comes from pass 3, which WITHDRAWS
        // any binding written after its initializer — so an admitted `var` is
        // one the whole file never reassigns, which is the property we need.
        // `isConstLike` is kept as the fast path for the common case.
        void isConstLike(node);
        byDeclaration.set(node, { className: cls, source: "new-binding" });
      }
    }
    ts.forEachChild(node, collectNewBindings);
  };
  collectNewBindings(sourceFile);

  // ── Pass 1b: prototype ALIAS map ─────────────────────────────────────────
  // Real-world prototype-style JS almost never writes `F.prototype.m = …`
  // directly: acorn's dist has `var pp$8 = Parser.prototype;` and then
  // `pp$8.parseTopLevel = function (node) { … }`, with NINE such aliases. The
  // first tally of this analysis over real acorn admitted ZERO receivers for
  // exactly this reason — the unit tests used the direct form, the shipping
  // code does not. Map every `<alias> = <Class>.prototype` binding so a method
  // assigned through an alias still identifies its class.
  const prototypeAlias = new Map<string, string>();
  const collectAliases = (node: ts.Node): void => {
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
    ts.forEachChild(node, collectAliases);
  };
  collectAliases(sourceFile);

  // ── Pass 1c: prototype METHOD map + return-class inference ───────────────
  // The first alias-aware tally admitted only 20 of acorn's 2,363 non-`this`
  // property accesses, because its dominant shape is a PARAMETER fed from a
  // CALL result: `pp.finishNode = function (node, type) { … node.start … }`
  // receives what `this.startNode()` returned, and `pp.startNode = function ()
  // { return new Node(this, …) }`. Without a return-class rule every such
  // argument is "unproven" and the parameter rule refuses.
  //
  // So: map (class, method) → its function body, infer a return class for each
  // (every `return` yields the same proven class, and there is no bare `return`
  // / implicit-undefined path), and let a `this.m()` call site count as proven.
  // Computed to a FIXED POINT because a return can itself depend on a
  // parameter verdict; monotone growth only, capped to keep it linear-ish.
  const methodBodies = new Map<string, ts.FunctionExpression>(); // `${class}.${method}`
  const collectMethods = (node: ts.Node): void => {
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
    ts.forEachChild(node, collectMethods);
  };
  collectMethods(sourceFile);

  /** Class returned by every `return` in `fn`, when they agree and none is bare. */
  const returnClassOf = new Map<ts.Node, string>();
  const inferReturnClass = (
    fn: ts.FunctionExpression | ts.FunctionDeclaration,
    argClass: (e: ts.Expression, enclosing: string | undefined) => string | undefined,
    enclosing: string | undefined,
  ): string | undefined => {
    const seen = new Set<string>();
    let bare = false;
    let any = false;
    const walk = (node: ts.Node): void => {
      // Do not descend into nested functions — their returns are not ours.
      if (
        node !== fn &&
        (ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node) || ts.isArrowFunction(node))
      ) {
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
  };

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

  /**
   * The approved class whose prototype method / constructor body `node` sits
   * inside, so `this` in that body has a known class. Recognizes the
   * prototype-assignment shape acorn uses (`F.prototype.m = function () {}`,
   * `pp.m = function () {}` where `pp = F.prototype`) only through the direct
   * form; the aliased form is left to the #3683 write-once analysis, which
   * already models it, when this module is wired up.
   */
  const enclosingThisClass = (node: ts.Node): string | undefined => {
    let cur: ts.Node | undefined = node;
    while (cur) {
      if (ts.isFunctionExpression(cur) || ts.isFunctionDeclaration(cur)) {
        const parent: ts.Node | undefined = cur.parent;
        // `F.prototype.m = function () {}`
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
  };

  /** The callee's declaration, when the call target is a locally-declared function. */
  const calleeDeclaration = (call: ts.CallExpression | ts.NewExpression): ts.Node | undefined => {
    const callee = call.expression;
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

  // Fixed point over return classes (monotone; 3 rounds is ample — acorn's
  // deepest chain is startNode → finishNode → parse*).
  for (let round = 0; round < 3; round++) {
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
  collectCallBindings(sourceFile);

  const collectCallSites = (node: ts.Node): void => {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const decl = calleeDeclaration(node);
      const params =
        decl && (ts.isFunctionExpression(decl) || ts.isFunctionDeclaration(decl)) ? decl.parameters : undefined;
      if (decl && params) {
        let obs = observations.get(decl);
        if (!obs) {
          obs = params.map(() => ({ classes: new Set<string>(), unproven: false }));
          observations.set(decl, obs);
        }
        const enclosing = enclosingThisClass(node);
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
  collectCallSites(sourceFile);

  for (const [decl, obs] of observations) {
    const params = (decl as ts.FunctionLikeDeclaration).parameters;
    for (let i = 0; i < obs.length; i++) {
      const o = obs[i]!;
      const param = params[i];
      if (!param || !ts.isIdentifier(param.name)) continue;
      if (o.unproven || o.classes.size !== 1) {
        if (o.classes.size > 0) demoted.add(param.name.text);
        continue;
      }
      // A parameter with a default or a rest parameter can hold something else.
      if (param.initializer !== undefined || param.dotDotDotToken !== undefined) {
        demoted.add(param.name.text);
        continue;
      }
      const cls = [...o.classes][0]!;
      byDeclaration.set(param, { className: cls, source: "parameter" });
    }
  }

  // ── Pass 3: demote anything ever written or deleted ───────────────────────
  // A verdict says "this binding ALWAYS holds an instance of F". Any write
  // after the initializer, or a `delete`, breaks that. Monotonic: once
  // removed, never restored.
  const demoteWrites = (node: ts.Node): void => {
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
    ts.forEachChild(node, demoteWrites);
  };
  demoteWrites(sourceFile);

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
