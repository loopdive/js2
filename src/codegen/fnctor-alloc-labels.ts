// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#3927) Allocation-site-sensitive shape analysis for widened fnctor structs —
 * the "per-type layouts" half of the issue, and the input the emission slice
 * consumes.
 *
 * ## What it computes
 * For one constructor `F`, the set of **allocation labels** its instances can
 * come from, and per label the set of property names that can be written to an
 * instance from that label. Two instances with different labels may then get
 * different WasmGC struct layouts, where today they share one struct carrying
 * the UNION of every shape (acorn's `Node`: 62 `externref` slots, 292 B, for a
 * median instance that populates a handful).
 *
 * ## Why the label is the FACTORY CALL SITE, not the `new`
 * #3927 §3 established against acorn that the `new`-site partition is trivial:
 * there are exactly three `new Node(…)` sites, all inside shape-agnostic
 * factories (`startNode` / `startNodeAt` / `copyNode`), and the discriminating
 * `type` tag is applied later, at `finishNode`. So a `new`-keyed analysis sees
 * ONE class whose downstream union is the whole union — nothing to separate.
 *
 * The fix is one level of call-site context (k=1): a function whose every
 * `return` is a direct `new F(…)` is **allocation-transparent**, and its CALL
 * SITES become the labels instead. Acorn has 2 such factories and 39 call
 * sites; measured, that turns one 62-field shape into 20 layouts averaging
 * ~10 fields.
 *
 * ## The identity summary is what makes it work at all
 * Without it the analysis is useless, and the reason is worth recording because
 * it is not obvious. Parser combinators are written as
 * `pp.finishNode = function (node, type) { …; return node }`, and every builder
 * is `parseX(node, …) { …; return this.finishNode(node, "X") }`. A plain
 * return-value join therefore makes EVERY `parseX()` call evaluate to "any node
 * ever allocated", and one shared write blurs its field onto every label.
 * Measured on acorn: with the join, 14.5 fields per label and 13 fields
 * universal; with pass-through summaries ({@link identityParamOf}), **6.3**
 * fields per label and only the constructor-assigned `type`/`end` universal.
 *
 * ## Soundness — and why a MISS is survivable
 * The analysis is a may-flow over-approximation of *where an object goes*, so a
 * label's field set can be too WIDE (a wasted slot, never a wrong answer).
 * It can also MISS flow — an object stored into an array or a property and
 * re-read is not tracked — and a missed flow means a missed write site. The
 * emission slice must therefore keep a residual carrier per layout so an
 * unproven write has somewhere to go; with that, a miss costs a lazily
 * allocated tail instead of a silently dropped property.
 *
 * ## Retyping needs no special case, by construction
 * acorn rewrites node kinds IN PLACE (`toAssignable`: ObjectExpression →
 * ObjectPattern, AssignmentExpression → AssignmentPattern, plus the one
 * `delete node.operator` in the whole library). Copy-on-retype is NOT available
 * — `toAssignableList` does `var elt = exprList[i]; this.toAssignable(elt, …)`
 * and never writes back, so a fresh copy would be dropped and every existing
 * reference would keep the old object — which is why the layout decision has to
 * be made at allocation time.
 *
 * This analysis is **flow-INSENSITIVE**: a label's field set is the union of
 * every write reachable from it, whenever it happens. A retype is just more
 * writes to the same object, so it cannot introduce a name outside the set.
 * {@link retypeSites} reports the retypes it can see so the property is
 * auditable rather than assumed, and {@link FnctorLayoutPlan.mergedByRetype}
 * names the labels a retype joins. Measured on acorn all four conversions are
 * ≤1 slot wide, so the widening they force is free — the value of proving it is
 * soundness in general, not bytes here.
 *
 * OFF unless `JS2WASM_FNCTOR_LAYOUTS` is set; `JS2WASM_FNCTOR_LAYOUT_DIAG=1`
 * prints the plan.
 */
import { ts, forEachChild } from "../ts-api.js";

/** One abstract allocation point of a fnctor's instances. */
export interface AllocLabel {
  /** Dense id, unique within the fnctor's plan. */
  readonly id: number;
  /** The factory CALL expression (k=1) or the direct `new F(…)`. */
  readonly site: ts.Node;
  /** 1-based source line of {@link site} — the only stable human handle. */
  readonly line: number;
  /** Property names provably written to an instance from this site. */
  readonly fields: ReadonlySet<string>;
}

/** One emitted layout: a distinct field-set signature shared by ≥1 label. */
export interface FnctorLayout {
  /** Canonical signature (sorted names, comma-joined) — the dedup key. */
  readonly key: string;
  readonly fields: readonly string[];
  readonly labelIds: readonly number[];
}

export type LayoutVerdict =
  /** Separable: emit per-layout structs. */
  | "split"
  /** More distinct shapes than the cap — keep the union struct. */
  | "too-many-shapes"
  /** Shapes exist but are not narrower than the union — no win, keep it. */
  | "not-separable"
  /** No transparent factory and one allocation site — nothing to separate. */
  | "single-site"
  /** The fnctor allocates nothing the analysis can see. */
  | "no-sites";

export interface FnctorLayoutPlan {
  readonly fnctorName: string;
  readonly verdict: LayoutVerdict;
  readonly labels: readonly AllocLabel[];
  readonly layouts: readonly FnctorLayout[];
  /** Every property name any label can receive — the residual universe. */
  readonly union: readonly string[];
  /** Mean label width as a fraction of {@link union} (0 = perfect separation). */
  readonly widthRatio: number;
  /** In-place kind rewrites seen (`recv.<disc> = <literal>` on a labelled recv). */
  readonly retypeSites: readonly {
    readonly line: number;
    readonly field: string;
    readonly labelIds: readonly number[];
  }[];
  /** Label ids a retype site joins — the groups that must share a widened layout. */
  readonly mergedByRetype: readonly (readonly number[])[];
}

export interface AllocLabelResult {
  /** Per fnctor NAME (the `__fnctor_<Name>` stem), its plan. */
  readonly plans: ReadonlyMap<string, FnctorLayoutPlan>;
  /**
   * Receiver pinning: an expression that provably denotes an instance from
   * EXACTLY one label maps to `{fnctorName, labelId}`. Multi-label expressions
   * are deliberately absent — the consumer must fall back to the base struct.
   */
  readonly labelOfExpr: ReadonlyMap<ts.Expression, { readonly fnctorName: string; readonly labelId: number }>;
}

/** Cap on distinct layouts per fnctor before the plan gives up (see {@link LayoutVerdict}). */
const MAX_LAYOUTS = 48;
/** A plan whose mean label is wider than this fraction of the union does not pay. */
const MAX_WIDTH_RATIO = 0.75;
/** Fixpoint round cap — acorn converges in 13. */
const MAX_ROUNDS = 40;
/** Identity-summary chase depth. */
const IDENTITY_DEPTH = 4;

export function fnctorLayoutsEnabled(): boolean {
  const raw = process.env.JS2WASM_FNCTOR_LAYOUTS;
  return raw !== undefined && raw !== "" && raw !== "0";
}

function unwrap(e: ts.Expression): ts.Expression {
  let x = e;
  while (ts.isParenthesizedExpression(x)) x = x.expression;
  return x;
}

function isFunctionLike(n: ts.Node): n is ts.FunctionLikeDeclaration {
  return (
    ts.isFunctionDeclaration(n) ||
    ts.isFunctionExpression(n) ||
    ts.isArrowFunction(n) ||
    ts.isMethodDeclaration(n) ||
    ts.isConstructorDeclaration(n)
  );
}

/**
 * `f.call(thisArg, …)` / `f.apply(…)` — acorn's `finishNodeAt.call(this, node,
 * type, …)` is on the hot path of EVERY node, so mis-shifting its arguments
 * would attribute `node.type` to the wrong parameter and blur the whole plan.
 */
function isThisArgCall(call: ts.CallExpression): boolean {
  const e = unwrap(call.expression);
  return ts.isPropertyAccessExpression(e) && (e.name.text === "call" || e.name.text === "apply");
}
function calleeArgs(call: ts.CallExpression): readonly ts.Expression[] {
  return isThisArgCall(call) ? call.arguments.slice(1) : call.arguments;
}

/** Every `return` expression of `fn`, not descending into nested functions. */
function returnsOf(fn: ts.FunctionLikeDeclaration): readonly ts.Expression[] {
  const body = fn.body;
  if (!body) return [];
  if (!ts.isBlock(body)) return [body];
  const out: ts.Expression[] = [];
  const walk = (n: ts.Node): void => {
    if (ts.isReturnStatement(n)) {
      if (n.expression) out.push(n.expression);
      return;
    }
    if (n !== body && isFunctionLike(n)) return;
    forEachChild(n, walk);
  };
  walk(body);
  return out;
}

/** Constructor-declaration symbols, so `new F(…)` resolves to a fnctor NAME. */
function fnctorSymbolIndex(
  checker: ts.TypeChecker,
  ctorDeclByName: ReadonlyMap<string, ts.FunctionLikeDeclaration>,
): ReadonlyMap<ts.Symbol, string> {
  const out = new Map<ts.Symbol, string>();
  for (const [name, decl] of ctorDeclByName) {
    const sym = decl.name ? checker.getSymbolAtLocation(decl.name) : undefined;
    if (sym) out.set(sym, name);
  }
  return out;
}

/** `new F(…)` → `F`'s fnctor name, or `undefined` for anything else. */
function newTargetOf(
  checker: ts.TypeChecker,
  e: ts.Expression,
  fnctorOfSymbol: ReadonlyMap<ts.Symbol, string>,
  ctorDeclByName: ReadonlyMap<string, ts.FunctionLikeDeclaration>,
): string | undefined {
  if (!ts.isNewExpression(e)) return undefined;
  const callee = unwrap(e.expression);
  if (!ts.isIdentifier(callee)) return undefined;
  const sym = checker.getSymbolAtLocation(callee);
  const bySym = sym ? fnctorOfSymbol.get(sym) : undefined;
  if (bySym !== undefined) return bySym;
  // Symbol miss (a bundled dist is a plain script and some `new` callees resolve
  // to an alias): fall back to the NAME, which is what the struct is keyed by
  // anyway (`__fnctor_<Name>`).
  return ctorDeclByName.has(callee.text) ? callee.text : undefined;
}

/**
 * Functions whose EVERY return is a direct `new F(…)` of the SAME `F` — the
 * allocation-transparent factories whose CALL SITES become the labels. Requiring
 * every return (not just one) is what makes the k=1 substitution sound: the call
 * site then accounts for the whole function's allocation behaviour.
 */
function findTransparentFactories(
  allFns: readonly ts.FunctionLikeDeclaration[],
  newTarget: (e: ts.Expression) => string | undefined,
): ReadonlyMap<ts.FunctionLikeDeclaration, string> {
  const out = new Map<ts.FunctionLikeDeclaration, string>();
  for (const fn of allFns) {
    const rets = returnsOf(fn);
    if (rets.length === 0) continue;
    let target: string | undefined;
    let ok = true;
    for (const r of rets) {
      const t = newTarget(unwrap(r));
      if (t === undefined || (target !== undefined && target !== t)) {
        ok = false;
        break;
      }
      target = t;
    }
    if (ok && target !== undefined) out.set(fn, target);
  }
  return out;
}

/** Everything one whole-program walk collects, so the fixpoint re-walks nothing. */
interface SourceIndex {
  /** `pp.m = function …` / `function m …`, keyed by NAME — the acorn form the checker leaves `any`. */
  readonly protoIndex: ReadonlyMap<string, ts.FunctionLikeDeclaration[]>;
  readonly allFns: readonly ts.FunctionLikeDeclaration[];
  readonly decls: readonly ts.VariableDeclaration[];
  /** `x = <expr>` with an IDENTIFIER lhs (the flow edges). */
  readonly assigns: readonly ts.BinaryExpression[];
  readonly calls: readonly ts.CallExpression[];
  /** `recv.p = <expr>` and `recv[k] = <expr>` (the shape edges). */
  readonly propWrites: readonly ts.BinaryExpression[];
}

/**
 * 1-based line of `n`, resolved against the node's OWN source file. (#4235)
 * Asking one designated file for the position of a node declared in another
 * silently answers from the wrong file's line table — under a multi-file graph
 * that turns every label's `line` into a plausible-looking wrong number, and a
 * diagnostic that lies is worse than one that is absent.
 */
function lineOf(n: ts.Node): number {
  const sf = n.getSourceFile();
  return sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
}

function indexSourceFile(sourceFiles: readonly ts.SourceFile[]): SourceIndex {
  const protoIndex = new Map<string, ts.FunctionLikeDeclaration[]>();
  const allFns: ts.FunctionLikeDeclaration[] = [];
  const decls: ts.VariableDeclaration[] = [];
  const assigns: ts.BinaryExpression[] = [];
  const calls: ts.CallExpression[] = [];
  const propWrites: ts.BinaryExpression[] = [];
  const indexNode = (n: ts.Node): void => {
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      if (ts.isPropertyAccessExpression(n.left)) {
        const rhs = unwrap(n.right);
        if (isFunctionLike(rhs)) {
          const arr = protoIndex.get(n.left.name.text);
          if (arr) arr.push(rhs);
          else protoIndex.set(n.left.name.text, [rhs]);
        }
        propWrites.push(n);
      } else if (ts.isElementAccessExpression(n.left)) {
        propWrites.push(n);
      } else if (ts.isIdentifier(n.left)) {
        assigns.push(n);
      }
    }
    if (ts.isFunctionDeclaration(n) && n.name) {
      const arr = protoIndex.get(n.name.text);
      if (arr) arr.push(n);
      else protoIndex.set(n.name.text, [n]);
    }
    if (isFunctionLike(n)) allFns.push(n);
    if (ts.isVariableDeclaration(n) && n.initializer && ts.isIdentifier(n.name)) decls.push(n);
    if (ts.isCallExpression(n)) calls.push(n);
    forEachChild(n, indexNode);
  };
  // (#4235) Index the WHOLE module graph. A layout derived from a strict subset
  // of a fnctor's allocation sites would omit fields written at the unseen ones
  // — the emitted `struct.new` would then have the wrong field set. Partial
  // visibility is not a weaker plan here, it is a wrong one.
  for (const sf of sourceFiles) indexNode(sf);
  return { protoIndex, allFns, decls, assigns, calls, propWrites };
}

/**
 * The label fixpoint. Kept as one closure-bearing function because `evalExpr`,
 * the label minting, the identity summaries and the callee cache are mutually
 * recursive over six shared indexes; the stages that are NOT mutually recursive
 * (source indexing, plan construction, diagnostics) are separate functions.
 */
export function analyzeFnctorAllocLabels(
  checker: ts.TypeChecker,
  sourceFiles: readonly ts.SourceFile[],
  /** `__fnctor_<Name>` stems to analyse, keyed by the CONSTRUCTOR declaration. */
  ctorDeclByName: ReadonlyMap<string, ts.FunctionLikeDeclaration>,
  /** (#4235) Which compile path ran this — printed by the diagnostic. */
  compilePath: "single" | "multi" = "single",
): AllocLabelResult {
  const { protoIndex, allFns, decls, assigns, calls, propWrites } = indexSourceFile(sourceFiles);

  /**
   * Callee resolution. Checker symbol first, then the syntactic prototype index
   * for the `this.<name>()` form the checker leaves `any` — the acorn-dominant
   * case. Ambiguous names resolve to ALL candidates; a caller that needs a
   * single answer checks `length === 1`.
   */
  const calleeCache = new Map<ts.CallExpression, readonly ts.FunctionLikeDeclaration[]>();
  function calleesOf(call: ts.CallExpression): readonly ts.FunctionLikeDeclaration[] {
    const hit = calleeCache.get(call);
    if (hit) return hit;
    let callee = unwrap(call.expression);
    if (isThisArgCall(call) && ts.isPropertyAccessExpression(callee)) callee = unwrap(callee.expression);
    const out: ts.FunctionLikeDeclaration[] = [];
    let sym: ts.Symbol | undefined;
    if (ts.isPropertyAccessExpression(callee)) sym = checker.getSymbolAtLocation(callee.name);
    else if (ts.isIdentifier(callee)) sym = checker.getSymbolAtLocation(callee);
    for (const d of sym?.getDeclarations() ?? []) {
      if (isFunctionLike(d) && d.body) out.push(d);
      else if (ts.isVariableDeclaration(d) && d.initializer) {
        const init = unwrap(d.initializer);
        if (isFunctionLike(init) && init.body) out.push(init);
      } else if (ts.isPropertyAccessExpression(d) && ts.isBinaryExpression(d.parent) && d.parent.left === d) {
        const rhs = unwrap(d.parent.right);
        if (isFunctionLike(rhs) && rhs.body) out.push(rhs);
      }
    }
    if (out.length === 0) {
      const name = ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : ts.isIdentifier(callee)
          ? callee.text
          : undefined;
      for (const f of (name === undefined ? undefined : protoIndex.get(name)) ?? []) if (f.body) out.push(f);
    }
    calleeCache.set(call, out);
    return out;
  }

  // ---- which constructors are in scope ------------------------------------
  const fnctorOfSymbol = fnctorSymbolIndex(checker, ctorDeclByName);
  const newTarget = (e: ts.Expression): string | undefined => newTargetOf(checker, e, fnctorOfSymbol, ctorDeclByName);
  const transparentOf = findTransparentFactories(allFns, newTarget);

  // ---- identity (pass-through) summaries ---------------------------------
  const identityCache = new Map<ts.FunctionLikeDeclaration, number | undefined>();
  function paramIndexOf(fn: ts.FunctionLikeDeclaration, e: ts.Expression): number {
    const x = unwrap(e);
    if (!ts.isIdentifier(x)) return -1;
    const sym = checker.getSymbolAtLocation(x);
    if (!sym) return -1;
    for (let i = 0; i < fn.parameters.length; i++) {
      const p = fn.parameters[i]!;
      if (ts.isIdentifier(p.name) && checker.getSymbolAtLocation(p.name) === sym) return i;
    }
    return -1;
  }
  /**
   * The parameter index `fn` returns unchanged on EVERY path, if any. This is
   * the summary that de-blurs the whole analysis (see the module header):
   * `finishNode(node, type) → node` and every `parseX(node, …)` built on it.
   */
  function identityParamOf(fn: ts.FunctionLikeDeclaration, depth = IDENTITY_DEPTH): number | undefined {
    const hit = identityCache.get(fn);
    if (hit !== undefined || identityCache.has(fn)) return hit;
    if (depth <= 0) return undefined;
    identityCache.set(fn, undefined); // recursion guard, refined below
    const rets = returnsOf(fn);
    if (rets.length === 0) return undefined;
    let idx: number | undefined;
    for (const r0 of rets) {
      const r = unwrap(r0);
      let here = paramIndexOf(fn, r);
      if (here < 0 && ts.isCallExpression(r)) {
        const args = calleeArgs(r);
        for (const g of calleesOf(r)) {
          const gi = identityParamOf(g, depth - 1);
          if (gi === undefined || gi >= args.length) continue;
          const via = paramIndexOf(fn, args[gi]!);
          if (via >= 0) here = via;
        }
      }
      if (here < 0) return undefined;
      if (idx !== undefined && idx !== here) return undefined;
      idx = here;
    }
    identityCache.set(fn, idx);
    return idx;
  }

  // ---- labels ------------------------------------------------------------
  interface LabelRec {
    id: number;
    fnctor: string;
    site: ts.Node;
    fields: Set<string>;
  }
  const labelBySite = new Map<ts.Node, LabelRec>();
  const labelsByFnctor = new Map<string, LabelRec[]>();
  function mintLabel(site: ts.Node, fnctor: string): LabelRec {
    const hit = labelBySite.get(site);
    if (hit) return hit;
    let arr = labelsByFnctor.get(fnctor);
    if (!arr) labelsByFnctor.set(fnctor, (arr = []));
    const rec: LabelRec = { id: arr.length, fnctor, site, fields: new Set() };
    arr.push(rec);
    labelBySite.set(site, rec);
    return rec;
  }

  // ---- the may-flow fixpoint ---------------------------------------------
  const env = new Map<ts.Symbol, Set<LabelRec>>();
  const retEnv = new Map<ts.FunctionLikeDeclaration, Set<LabelRec>>();
  const bag = (m: Map<object, Set<LabelRec>>, k: object): Set<LabelRec> => {
    let s = m.get(k);
    if (!s) m.set(k, (s = new Set()));
    return s;
  };
  const EMPTY: ReadonlySet<LabelRec> = new Set();

  function evalExpr(e0: ts.Expression): ReadonlySet<LabelRec> {
    const e = unwrap(e0);
    if (ts.isIdentifier(e)) {
      const sym = checker.getSymbolAtLocation(e);
      return sym ? (env.get(sym) ?? EMPTY) : EMPTY;
    }
    const nt = newTarget(e);
    if (nt !== undefined) return new Set([mintLabel(e, nt)]);
    if (ts.isCallExpression(e)) {
      const fns = calleesOf(e);
      if (fns.length === 0) return EMPTY;
      // k=1: a call whose every callee is an allocation-transparent factory of
      // the same fnctor IS the label. The `new` inside is never a label of its
      // own — that is the whole point (see the module header).
      const first = transparentOf.get(fns[0]!);
      if (first !== undefined && fns.every((f) => transparentOf.get(f) === first)) {
        return new Set([mintLabel(e, first)]);
      }
      const out = new Set<LabelRec>();
      const args = calleeArgs(e);
      for (const f of fns) {
        const id = identityParamOf(f);
        if (id !== undefined) {
          if (id < args.length) for (const l of evalExpr(args[id]!)) out.add(l);
          continue;
        }
        for (const l of retEnv.get(f) ?? EMPTY) out.add(l);
      }
      return out;
    }
    if (ts.isBinaryExpression(e)) {
      if (e.operatorToken.kind === ts.SyntaxKind.EqualsToken) return evalExpr(e.right);
      if (
        e.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        e.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
      ) {
        return new Set([...evalExpr(e.left), ...evalExpr(e.right)]);
      }
      return EMPTY;
    }
    if (ts.isConditionalExpression(e)) {
      return new Set([...evalExpr(e.whenTrue), ...evalExpr(e.whenFalse)]);
    }
    return EMPTY;
  }

  function addAll(dst: Set<LabelRec>, src: ReadonlySet<LabelRec>): boolean {
    let changed = false;
    for (const l of src) {
      if (!dst.has(l)) {
        dst.add(l);
        changed = true;
      }
    }
    return changed;
  }

  let changed = true;
  let rounds = 0;
  while (changed && rounds++ < MAX_ROUNDS) {
    changed = false;
    for (const d of decls) {
      const sym = checker.getSymbolAtLocation(d.name);
      if (sym) changed = addAll(bag(env, sym), evalExpr(d.initializer!)) || changed;
    }
    for (const a of assigns) {
      const sym = checker.getSymbolAtLocation(a.left);
      if (sym) changed = addAll(bag(env, sym), evalExpr(a.right)) || changed;
    }
    for (const c of calls) {
      const args = calleeArgs(c);
      for (const f of calleesOf(c)) {
        if (transparentOf.has(f)) continue;
        const n = Math.min(args.length, f.parameters.length);
        for (let i = 0; i < n; i++) {
          const p = f.parameters[i]!;
          if (!ts.isIdentifier(p.name)) continue;
          const sym = checker.getSymbolAtLocation(p.name);
          if (sym) changed = addAll(bag(env, sym), evalExpr(args[i]!)) || changed;
        }
      }
    }
    for (const f of allFns) {
      if (transparentOf.has(f) || identityParamOf(f) !== undefined) continue;
      for (const r of returnsOf(f)) changed = addAll(bag(retEnv, f), evalExpr(r)) || changed;
    }
  }

  // ---- attribute writes ---------------------------------------------------
  const retypeByFnctor = new Map<string, { line: number; field: string; labelIds: number[] }[]>();
  const mergedByFnctor = new Map<string, number[][]>();
  for (const w of propWrites) {
    const lhs = w.left;
    if (!ts.isPropertyAccessExpression(lhs)) continue; // computed writes: residual-carrier territory
    const labels = evalExpr(lhs.expression);
    if (labels.size === 0) continue;
    const name = lhs.name.text;
    for (const l of labels) l.fields.add(name);
    // A retype is a kind-discriminant rewrite: `recv.<f> = <string literal>` on
    // an already-labelled receiver. Recorded (not acted on) — the plan is
    // flow-INSENSITIVE, so the post-retype writes are already in every affected
    // label's set; this makes that auditable instead of assumed.
    const rhs = unwrap(w.right);
    if (ts.isStringLiteral(rhs) && labels.size > 0) {
      const byF = new Map<string, LabelRec[]>();
      for (const l of labels) {
        const arr = byF.get(l.fnctor);
        if (arr) arr.push(l);
        else byF.set(l.fnctor, [l]);
      }
      for (const [fn, ls] of byF) {
        const ids = ls.map((l) => l.id).sort((a, b) => a - b);
        const rs = retypeByFnctor.get(fn);
        const rec = { line: lineOf(w), field: name, labelIds: ids };
        if (rs) rs.push(rec);
        else retypeByFnctor.set(fn, [rec]);
        if (ids.length > 1) {
          const ms = mergedByFnctor.get(fn);
          if (ms) ms.push(ids);
          else mergedByFnctor.set(fn, [ids]);
        }
      }
    }
  }

  // ---- plans --------------------------------------------------------------
  const plans = new Map<string, FnctorLayoutPlan>();
  for (const fnctorName of ctorDeclByName.keys()) {
    plans.set(
      fnctorName,
      buildPlan(
        fnctorName,
        labelsByFnctor.get(fnctorName) ?? [],
        lineOf,
        retypeByFnctor.get(fnctorName) ?? [],
        mergedByFnctor.get(fnctorName) ?? [],
      ),
    );
  }

  // ---- receiver pinning ---------------------------------------------------
  // Only SINGLE-label expressions are published: a consumer that pins on a
  // multi-label receiver would pick one arbitrary layout and read the wrong
  // slot. Absence means "use the base struct", which is always correct.
  const labelOfExpr = new Map<ts.Expression, { fnctorName: string; labelId: number }>();
  const publish = (e: ts.Expression): void => {
    const labels = evalExpr(e);
    if (labels.size !== 1) return;
    const [only] = labels;
    if (plans.get(only!.fnctor)?.verdict !== "split") return;
    labelOfExpr.set(e, { fnctorName: only!.fnctor, labelId: only!.id });
  };
  for (const [sym, labels] of env) {
    if (labels.size !== 1) continue;
    for (const d of sym.getDeclarations() ?? []) {
      if (ts.isVariableDeclaration(d) && ts.isIdentifier(d.name)) publish(d.name);
      else if (ts.isParameter(d) && ts.isIdentifier(d.name)) publish(d.name);
    }
  }
  for (const c of calls) publish(c);

  if (process.env.JS2WASM_FNCTOR_LAYOUT_DIAG === "1") {
    writeLayoutDiag(plans, rounds, compilePath, sourceFiles.length);
  }

  return { plans, labelOfExpr };
}

/** Derive one fnctor's plan + verdict from its raw label records. */
function buildPlan(
  fnctorName: string,
  recs: readonly { id: number; site: ts.Node; fields: Set<string> }[],
  lineOf: (n: ts.Node) => number,
  retypeSites: readonly { line: number; field: string; labelIds: number[] }[],
  mergedByRetype: readonly number[][],
): FnctorLayoutPlan {
  const union = new Set<string>();
  for (const r of recs) for (const f of r.fields) union.add(f);
  const labels: AllocLabel[] = recs.map((r) => ({ id: r.id, site: r.site, line: lineOf(r.site), fields: r.fields }));
  const byKey = new Map<string, { key: string; fields: string[]; labelIds: number[] }>();
  for (const r of recs) {
    const fields = [...r.fields].sort();
    const key = fields.join(",");
    const hit = byKey.get(key);
    if (hit) hit.labelIds.push(r.id);
    else byKey.set(key, { key, fields, labelIds: [r.id] });
  }
  const layouts = [...byKey.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const meanWidth = recs.length === 0 ? 0 : recs.reduce((a, r) => a + r.fields.size, 0) / recs.length;
  const widthRatio = union.size === 0 ? 0 : meanWidth / union.size;
  // `union.size === 0` is a fnctor whose instances never grow a field beyond the
  // constructor's own writes — there IS no widening to undo, so it must not read
  // as "split" (acorn's `Token` is one: 4 labels, zero flow-grown names).
  const verdict: LayoutVerdict =
    recs.length === 0 || union.size === 0
      ? "no-sites"
      : recs.length === 1
        ? "single-site"
        : layouts.length > MAX_LAYOUTS
          ? "too-many-shapes"
          : widthRatio > MAX_WIDTH_RATIO
            ? "not-separable"
            : "split";
  return {
    fnctorName,
    verdict,
    labels,
    layouts,
    union: [...union].sort(),
    widthRatio,
    retypeSites,
    mergedByRetype,
  };
}

/**
 * Human-readable plan dump. The per-label field list is the thing a byte number
 * cannot tell you and the first question when a consumer turns out not to know
 * a layout, so it prints in full rather than summarised.
 *
 * (#4235) It now leads with the COMPILE PATH and file count, and emits a header
 * even when there is nothing to report. Before this, a multi-file compile
 * printed nothing at all — and "no `[alloc-labels]` lines" was read as "this
 * package has no fnctors" when the truth was "this path never ran the
 * analysis". A zero must arrive with its provenance attached or it is not a
 * measurement.
 */
function writeLayoutDiag(
  plans: ReadonlyMap<string, FnctorLayoutPlan>,
  rounds: number,
  compilePath: "single" | "multi",
  sourceFileCount: number,
): void {
  const planned = [...plans.values()].filter((p) => p.labels.length > 0).length;
  process.stderr.write(
    `[alloc-labels] path=${compilePath} files=${sourceFileCount} ` +
      `families=${plans.size} with-labels=${planned} rounds=${rounds}\n`,
  );
  for (const plan of plans.values()) {
    if (plan.labels.length === 0) continue;
    process.stderr.write(
      `[alloc-labels] ${plan.fnctorName}: verdict=${plan.verdict} labels=${plan.labels.length} ` +
        `layouts=${plan.layouts.length} union=${plan.union.length} width=${plan.widthRatio.toFixed(3)} ` +
        `retypes=${plan.retypeSites.length} rounds=${rounds}\n`,
    );
    for (const l of [...plan.labels].sort((a, b) => a.fields.size - b.fields.size)) {
      process.stderr.write(
        `[alloc-labels]   L${l.id} line ${l.line} (${l.fields.size}) ${[...l.fields].sort().join(",")}\n`,
      );
    }
    for (const r of plan.retypeSites) {
      process.stderr.write(`[alloc-labels]   retype line ${r.line} .${r.field} -> L[${r.labelIds.join(",")}]\n`);
    }
  }
}
