// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2660 S1 — whole-program escape / dynamic-use classification for `new F()`
 * function-constructor ("fnctor") instances.
 *
 * This is the **inert analysis** slice (S1) of the #2660 value-rep
 * infrastructure. It computes, per `new F()` allocation site (where `F` is a
 * plain function constructor — a `FunctionDeclaration` / `FunctionExpression` /
 * `var F = function`, NOT a `class`), whether the constructed instance is a
 * candidate for the future #2660 S3 `$Object` reconstruction.
 *
 * The gate predicate (see #2660 `## Implementation Plan`) approves a site for
 * reconstruction iff BOTH hold:
 *   - **(A) dynamically consumed** — at least one use of the instance (or a
 *     binding it flows into) is a *dynamic* access: it is the receiver of a
 *     generic-method `.call` / `.apply`, a computed / `any`-typed member read,
 *     or it is passed to an `any`-typed parameter / returned as `any`. These are
 *     the uses that need the `$Object.$proto` walk the bespoke
 *     `$__fnctor_<Name>` struct cannot provide.
 *   - **(B) NO typed own-field consumer** — NO use resolves to a typed
 *     `instance.<ownField>` read/write that would lower to `struct.get` /
 *     `struct.set` on the fnctor struct. This is the hot-path-protection clause:
 *     reconstructing a site that has a typed field read would move that read onto
 *     `__extern_get` and regress it (the #1888-floor eject). A site with ANY
 *     typed-field consumer is therefore NEVER approved.
 *
 * **Conservative default = do NOT approve.** A site the analysis cannot prove
 * satisfies (A)∧(B) is classified `keep` (status-quo lowering). The failure mode
 * is bounded to "miss a reconstruction candidate" (0 rows), NEVER "approve a
 * typed `new F()`" (which would be the floor regression). This inversion is what
 * makes an imprecise/incomplete analysis safe.
 *
 * **S1 is INERT.** This module performs NO codegen and has NO side effects on the
 * module. The result is stored on `ctx` and (optionally) logged, but is NOT yet
 * consumed by any lowering decision — S3 wires `compileNewFunctionDeclaration` to
 * consult it. Removing this pass cannot change emitted Wasm.
 *
 * Relation to the IR `analyzeEscape` (`src/ir/analysis/escape.ts`, #747): that is
 * a DIFFERENT, per-function analysis classifying closure/allocation *escape* for
 * stack-allocation / scalar-replacement, over the IR. This pass is whole-program,
 * over the AST (the fnctor lowering lives on the direct AST→Wasm path, not the
 * IR), and classifies dynamic-vs-typed *use*. They are siblings; they may later
 * share an alias oracle, but the questions they answer are distinct.
 */
import { ts, forEachChild } from "../ts-api.js";
import type { FieldDef } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { appendFnctorInternalFields } from "./fnctor-identity-fields.js";
import { resolveWasmType } from "./index.js";

/** Classification of a `new F()` fnctor allocation site. */
export type FnctorGateClass =
  /** (A)∧(B): dynamically consumed, no typed own-field consumer → S3 candidate. */
  | "reconstruct"
  /** Has a typed own-field consumer (clause B fails) → never reconstruct (hot path). */
  | "keep-typed"
  /** No dynamic consumer found (clause A fails) → no reconstruction needed. */
  | "keep-static";

/** Result of the #2660 S1 fnctor escape/dynamic-use analysis (frozen before codegen). */
export interface FnctorEscapeGateResult {
  /**
   * Per `new F()` site classification, keyed by the `NewExpression` AST node.
   * S3 consults this via the node identity at `compileNewFunctionDeclaration`.
   */
  readonly sites: ReadonlyMap<ts.NewExpression, FnctorGateClass>;
  /** Sites approved for reconstruction (`reconstruct`) — the (A)∧(B) set. */
  readonly approved: ReadonlySet<ts.NewExpression>;
  /**
   * Fnctor symbol NAMES that have ≥1 `reconstruct`-classified `new F()` site —
   * i.e. the constructors S3 will reconstruct as `$Object`. #2660 S2 gates its
   * per-fnctor prototype `$Object` materialization on this set so it ONLY touches
   * constructors whose instances need the `$proto` walk; a `keep-typed` /
   * `keep-static` / never-`new`'d function (e.g. `Test262Error`, a species
   * `Ctor` used only via `Object.getPrototypeOf`) keeps its existing prototype
   * behaviour untouched (avoids the identity/harness regressions an unscoped
   * interception caused).
   */
  readonly approvedNames: ReadonlySet<string>;
  /**
   * #2660 PART-1 — receiver-expression → `__fnctor_<Name>` struct-name flow map.
   *
   * Keyed by every USE-site expression (the identifier nodes) of a LOCAL binding
   * `const/let/var x = <call>` whose initializer call is a *single-return-
   * inferable* fnctor-returning method (e.g. `var node = this.startNode()` where
   * `startNode` is the aliased-prototype method `pp.startNode = function(){ return
   * new Node(...) }`). The mapped value is the `__fnctor_<Name>` struct name
   * (the `ctx.structMap` key from `new-super.ts`). It lets the PART-2 dispatch
   * pin the dynamic `x.<field>` read/write/compound to that one struct instead of
   * the open-scan `findAlternateStructsForField` — the local-receiver half of the
   * #2660 substrate (the `this`-receiver half is `FunctionContext.thisStructName`,
   * resolution case (1)).
   *
   * **Conservative-closed**: only bindings whose initializer resolves to a SINGLE
   * `return new X()` / `return <single-return call>` chain (depth-capped,
   * memoized) are recorded; anything ambiguous is omitted ⇒ `resolveReceiverStruct`
   * returns `undefined` ⇒ the consumer stays on the dynamic path. A miss NEVER
   * yields a wrong struct.
   *
   * **INERT in PART-1**: produced here but consulted only by the (as-yet-uncalled)
   * `resolveReceiverStruct`; no lowering reads it, so emitted Wasm is byte-identical.
   */
  readonly receiverStruct: ReadonlyMap<ts.Expression, string>;
  /**
   * #2773 S2b — fnctor NAMES that own a `new this()` reconstruct site (a
   * `new this()` inside a static / prototype method classified as an `F`
   * reconstruct). The #2773 S1 up-front struct-type reservation
   * (`reserveFnctorStructTypes`) unions this with {@link approvedNames} so a
   * `Parser` reconstructed via `new this()` also gets a reserved
   * `$__fnctor_Parser` slot. **S1 ships this as an EMPTY set** — S1 only READS it
   * (so the reservation union is a no-op today); S2b populates it. Landing the
   * field shape here keeps S2b purely additive.
   */
  readonly newThisOwnerNames: ReadonlySet<string>;
  /**
   * #2773 S1 — fnctor NAME → its function-like declaration (the body-bearer whose
   * `this.<field> = …` writes derive the `$__fnctor_<Name>` struct shape). Covers
   * EVERY fnctor `new F()` site seen (not just approved ones) so
   * `reserveFnctorStructTypes` can resolve a name to the SAME declaration the
   * on-demand `compileNewFunctionDeclaration` path uses — guaranteeing identical
   * field derivation. A name with ≥2 distinct declarations keeps the first
   * (deterministic by source order); ambiguity here only affects WHICH body shapes
   * the reserved slot (matching the on-demand resolution at the dominant site).
   */
  readonly ctorDeclByName: ReadonlyMap<string, ts.FunctionDeclaration | ts.FunctionExpression>;
  /**
   * #3683 S1 — per-fnctor prototype-method WRITE-ONCE verdicts. INERT: no
   * lowering consumes this yet; #3683 S2 gates typed-`this` twin emission on
   * it. See {@link analyzeProtoMethodWriteOnce}.
   */
  readonly protoMethodWriteOnce: ProtoMethodWriteOnceResult;
}

/**
 * #3683 S1 — result of the prototype-method write-once analysis.
 *
 * `methods.get(F)?.get(m)` is the SINGLE function-like RHS of the one
 * unconditional top-level assignment `F.prototype.m = <fn>` (directly or via a
 * top-level alias `var pp = F.prototype; pp.m = <fn>`), present only when the
 * program provably never writes that method slot again. `poisoned` holds
 * fnctor names whose prototype OBJECT cannot be reasoned about at all — its
 * `prototype` was reassigned, written through a computed key, `delete`d from,
 * or ESCAPED to any consumer other than a property access or the whitelisted
 * non-mutating readers (`Object.create` / `Object.getPrototypeOf` argument
 * position). A poisoned class publishes NO verdicts.
 *
 * **Conservative default = not write-once.** Shadowed alias names, writes
 * inside functions/conditionals, double assignments, and non-function RHS all
 * demote the method (or poison the class); the failure mode is only ever
 * "miss a monomorphization candidate", never "typed twin for a mutable slot".
 */
export interface ProtoMethodWriteOnceResult {
  readonly methods: ReadonlyMap<string, ReadonlyMap<string, ts.FunctionLikeDeclaration>>;
  readonly poisoned: ReadonlySet<string>;
  /**
   * #3683 S1b — property NAMES written ANYWHERE outside the recognized
   * write-once prototype assignments: instance expando writes (`this.x = …`,
   * `obj.m = …`), double/conditional proto writes, defineProperty keys.
   * A method admitted for DIRECT-CALL devirtualization (S3) must not appear
   * here — a name never written elsewhere cannot be shadowed by an own
   * property or a second definition, so `this.<m>()` provably resolves to
   * the single write-once closure. `null` (the sentinel) means a non-symbol
   * COMPUTED member write exists somewhere (`obj[k] = …`) — any name could
   * be written, so S3 must not devirtualize by name alone (receiver-shape
   * runtime guards are then required).
   */
  readonly otherNameWrites: ReadonlySet<string> | null;
  /**
   * #3683 S1b — fnctor names whose `.prototype` appears as an
   * `Object.create(F.prototype)` argument: some OTHER object inherits from
   * F's prototype, so an inherited `this.<m>()` in F's methods may execute
   * with a receiver whose own chain overrides `m`. S3 must not devirtualize
   * methods of these classes without a receiver-type runtime guard.
   */
  readonly inheritedFrom: ReadonlySet<string>;
  /** Prototype property names installed through Object.defineProperty(ies). */
  readonly runtimeDefined: ReadonlyMap<string, ReadonlySet<string>>;
}

const EMPTY_WRITE_ONCE: ProtoMethodWriteOnceResult = {
  methods: new Map(),
  poisoned: new Set(),
  otherNameWrites: new Set(),
  inheritedFrom: new Set(),
  runtimeDefined: new Map(),
};

const EMPTY_RESULT: FnctorEscapeGateResult = {
  sites: new Map(),
  approved: new Set(),
  approvedNames: new Set(),
  receiverStruct: new Map(),
  newThisOwnerNames: new Set(),
  ctorDeclByName: new Map(),
  protoMethodWriteOnce: EMPTY_WRITE_ONCE,
};

/**
 * Resolve a fnctor symbol to the function-like declaration that supplies its
 * constructor body — a top-level `function F(){…}`, a `var F = function(){…}`, or
 * a bare `FunctionExpression`. Returns `undefined` for anything else (arrow, class
 * — those never reach here via `resolveFnctorSymbol`).
 */
function fnctorDeclFromSymbol(sym: ts.Symbol): ts.FunctionDeclaration | ts.FunctionExpression | undefined {
  for (const decl of sym.getDeclarations() ?? []) {
    if (ts.isFunctionDeclaration(decl) && decl.body) return decl;
    if (ts.isFunctionExpression(decl) && decl.body) return decl;
    if (ts.isVariableDeclaration(decl) && decl.initializer) {
      let init: ts.Expression = decl.initializer;
      while (ts.isParenthesizedExpression(init)) init = init.expression;
      if (ts.isFunctionExpression(init) && init.body) return init;
    }
  }
  return undefined;
}

/** Max callee-chain depth the single-return struct inference will follow. */
const RETURN_INFER_MAX_DEPTH = 6;

/** A generic Array/Function method that, used as `m.call(recv,…)`, makes `recv` array-like-dynamic. */
const GENERIC_METHOD_CALL = new Set(["call", "apply", "bind"]);

/**
 * Whether `expr` resolves to a plain function constructor (fnctor) rather than a
 * `class`. Mirrors the recognition `compileNewExpression` uses to route to
 * `compileNewFunctionDeclaration`: the callee symbol has a `FunctionDeclaration`
 * / `FunctionExpression` declaration (or a `var F = function …`), and is not a
 * class. Returns the resolved constructor symbol when it is a fnctor, else
 * `undefined`.
 */
export function resolveFnctorSymbol(checker: ts.TypeChecker, calleeExpr: ts.Expression): ts.Symbol | undefined {
  let e: ts.Expression = calleeExpr;
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e)) {
    e = (e as ts.ParenthesizedExpression | ts.AsExpression | ts.NonNullExpression).expression;
  }
  if (!ts.isIdentifier(e)) return undefined;
  const sym = checker.getSymbolAtLocation(e);
  const decls = sym?.getDeclarations();
  if (!sym || !decls) return undefined;
  for (const decl of decls) {
    // A class `new` is NOT a fnctor — it has its own lowering.
    if (ts.isClassDeclaration(decl) || ts.isClassExpression(decl)) return undefined;
    if (ts.isFunctionDeclaration(decl) && decl.body) return sym;
    if (ts.isFunctionExpression(decl) && decl.body) return sym;
    if (ts.isVariableDeclaration(decl) && decl.initializer) {
      let init: ts.Expression = decl.initializer;
      while (ts.isParenthesizedExpression(init)) init = init.expression;
      if (ts.isFunctionExpression(init) && init.body) return sym;
      if (ts.isArrowFunction(init)) return undefined; // arrows are not constructors
    }
  }
  return undefined;
}

/**
 * #2681/#2686 — resolve the fnctor `F` that OWNS the enclosing method a node sits
 * in, for a `new this(…)` site or a lifted method body. `this` inside a method
 * `F.method = function(){…}` / `F.prototype.m = function(){…}` / aliased `var pp =
 * F.prototype; pp.m = function(){…}` binds to `F` (static) or an `F` instance
 * (prototype). Walks up to the nearest non-arrow function (arrows do not rebind
 * `this`) and resolves its defining assignment's holder to a fnctor symbol.
 *
 * Returns `{ name, sym, viaPrototype }` where `viaPrototype` is true for a
 * prototype/aliased method (`this` is an INSTANCE — the read-dispatch case) and
 * false for a direct static method (`this` is the CONSTRUCTOR — the `new this()`
 * reconstruct case). `undefined` when the enclosing function is not a fnctor
 * method, or the holder does not resolve to a user fnctor.
 */
export function resolveEnclosingFnctorOwner(
  checker: ts.TypeChecker,
  node: ts.Node,
): { name: string; sym: ts.Symbol; viaPrototype: boolean } | undefined {
  // Walk up to the nearest `this`-rebinding function (FunctionExpression /
  // FunctionDeclaration). Arrows are transparent to `this`, so a `new this()` in
  // an arrow refers to the enclosing function's `this` — keep walking through them.
  let fn: ts.Node | undefined = node;
  while (fn && !ts.isFunctionExpression(fn) && !ts.isFunctionDeclaration(fn)) {
    fn = fn.parent;
  }
  if (!fn) return undefined;
  const assign = fn.parent;
  if (
    !ts.isBinaryExpression(assign) ||
    assign.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
    assign.right !== fn ||
    !ts.isPropertyAccessExpression(assign.left)
  ) {
    return undefined;
  }
  const left = assign.left;
  // prototype `F.prototype.m = fn` → holder F = left.expression.expression.
  if (
    ts.isPropertyAccessExpression(left.expression) &&
    ts.isIdentifier(left.expression.name) &&
    left.expression.name.text === "prototype"
  ) {
    const sym = resolveFnctorSymbol(checker, left.expression.expression);
    if (sym) return { name: sym.name, sym, viaPrototype: true };
    return undefined;
  }
  // static `F.method = fn` (holder = F directly) OR aliased `pp.m = fn` where
  // `var pp = F.prototype` (holder = pp → F, via the alias initializer).
  const holder = left.expression;
  const direct = resolveFnctorSymbol(checker, holder);
  if (direct) return { name: direct.name, sym: direct, viaPrototype: false };
  if (ts.isIdentifier(holder)) {
    const hsym = checker.getSymbolAtLocation(holder);
    for (const decl of hsym?.getDeclarations() ?? []) {
      if (ts.isVariableDeclaration(decl) && decl.initializer) {
        let init: ts.Expression = decl.initializer;
        while (ts.isParenthesizedExpression(init)) init = init.expression;
        if (ts.isPropertyAccessExpression(init) && ts.isIdentifier(init.name) && init.name.text === "prototype") {
          const fsym = resolveFnctorSymbol(checker, init.expression);
          if (fsym) return { name: fsym.name, sym: fsym, viaPrototype: true };
        }
      }
    }
  }
  return undefined;
}

/**
 * #2681/#2686 A3 — the `__fnctor_<F>` struct name a lifted PROTOTYPE method's
 * `this` receiver resolves to, when `F` is approved for reconstruction. Sets
 * `FunctionContext.thisStructName` (closures.ts) so the dynamic `this.<field>`
 * read dispatch (property-access.ts) routes through the finalize-filled
 * `__get_member_<name>` dispatcher.
 *
 * Deliberately NOT gated on `ctx.structMap.has(__fnctor_<F>)`: the reader method
 * frequently compiles BEFORE the `new this()` site that registers the struct
 * (acorn defines `pp.parseExprAtom` long before the static `Parser.parse`). The
 * dispatcher is reserved at the read site and FILLED at finalize over the
 * COMPLETE type table, so a struct registered later is still enumerated — pinning
 * on `approvedNames` (frozen pre-codegen at index.ts) is order-independent and
 * correct, while a `structMap.has` gate would race the compile order and miss.
 * Excludes static methods (`viaPrototype === false`) — their `this` is the
 * constructor function-value, not an instance.
 */
export function resolveLiftedMethodThisStruct(
  ctx: CodegenContext,
  fn: ts.FunctionExpression | ts.ArrowFunction,
): string | undefined {
  const owner = resolveEnclosingFnctorOwner(ctx.checker, fn);
  if (!owner || !owner.viaPrototype) return undefined;
  if (!ctx.fnctorEscapeGate?.approvedNames.has(owner.name)) return undefined;
  return `__fnctor_${owner.name}`;
}

/**
 * The set of own property names a fnctor constructor assigns to `this` in its
 * body (`this.x = …`). A typed `instance.x` read of one of these lowers to a
 * `struct.get` on the `$__fnctor_<Name>` struct — clause (B)'s hot path.
 */
function collectFnctorOwnFields(ctorSym: ts.Symbol): Set<string> {
  const fields = new Set<string>();
  const decls = ctorSym.getDeclarations() ?? [];
  for (const decl of decls) {
    let body: ts.Block | undefined;
    if ((ts.isFunctionDeclaration(decl) || ts.isFunctionExpression(decl)) && decl.body) body = decl.body;
    else if (ts.isVariableDeclaration(decl) && decl.initializer) {
      let init: ts.Expression = decl.initializer;
      while (ts.isParenthesizedExpression(init)) init = init.expression;
      if (ts.isFunctionExpression(init) && init.body) body = init.body;
    }
    if (!body) continue;
    const walk = (node: ts.Node): void => {
      // `this.x = …`
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(node.left) &&
        node.left.expression.kind === ts.SyntaxKind.ThisKeyword
      ) {
        fields.add(node.left.name.text);
      }
      forEachChild(node, walk);
    };
    walk(body);
  }
  return fields;
}

/**
 * Classify how a single use-site of a fnctor instance reads it. Returns:
 *   - `"typed"`   — a typed own-field access (clause B trip → keep-typed).
 *   - `"dynamic"` — a dynamic access (clause A satisfied).
 *   - `"neutral"` — neither (e.g. identity compare, `typeof`); does not decide.
 *
 * Conservative: an unrecognised use that COULD be a typed field read is treated
 * as `"typed"` (keep), never as `"dynamic"`.
 */
function classifyUse(
  checker: ts.TypeChecker,
  idNode: ts.Identifier,
  ownFields: ReadonlySet<string>,
): "typed" | "dynamic" | "neutral" {
  const parent = idNode.parent;

  // `inst.<name>` — property access.
  if (ts.isPropertyAccessExpression(parent) && parent.expression === idNode) {
    const name = parent.name.text;
    // `inst.method.call(...)` / `inst.method.apply(...)` reflective dispatch is
    // dynamic ONLY when `inst` is the receiver ARG, not the method holder; a bare
    // `inst.method` access of a fnctor-prototype method is the dynamic-dispatch
    // case the substrate needs. A static OWN field read is typed.
    if (ownFields.has(name)) return "typed";
    // A non-own-field named access on a fnctor instance is an inherited /
    // prototype-chain read — the dynamic case (resolved at runtime via the
    // $proto walk). This is exactly what reconstruction enables.
    return "dynamic";
  }

  // `inst[expr]` — element access. Computed/indexed reads are dynamic.
  if (ts.isElementAccessExpression(parent) && parent.expression === idNode) {
    return "dynamic";
  }

  // `table[key] = inst` / `table.name = inst` — storing the instance in an
  // object property lets later reads recover it through the dynamic object
  // carrier. Treat that as an escape so the allocation and the table value use
  // one representation instead of sibling nominal WasmGC shapes.
  if (
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    parent.right === idNode &&
    (ts.isPropertyAccessExpression(parent.left) || ts.isElementAccessExpression(parent.left))
  ) {
    return "dynamic";
  }

  // `someMethod.call(inst, …)` / `.apply(inst, …)` — `inst` is the receiver arg
  // of a reflective generic-method call → array-like dynamic use.
  if (ts.isCallExpression(parent) && parent.arguments.length > 0 && parent.arguments[0] === idNode) {
    const callee = parent.expression;
    if (ts.isPropertyAccessExpression(callee) && GENERIC_METHOD_CALL.has(callee.name.text)) {
      return "dynamic";
    }
  }

  // Passed as a call argument to a parameter typed `any`/`unknown` → dynamic
  // (the callee may read it dynamically). Conservative: only the explicit
  // any/unknown parameter counts as dynamic; a typed parameter is neutral here
  // (the callee's own uses would be classified at that param's site in a fuller
  // interprocedural pass — out of scope for S1's conservative single-level view).
  if (ts.isCallExpression(parent)) {
    const argIdx = parent.arguments.indexOf(idNode);
    if (argIdx >= 0) {
      const sig = checker.getResolvedSignature(parent);
      const paramSym = sig?.parameters[argIdx];
      if (paramSym) {
        const pType = checker.getTypeOfSymbolAtLocation(paramSym, idNode);
        if (isAnyOrUnknown(pType)) return "dynamic";
      }
      return "neutral";
    }
  }

  // `return inst;` from a function whose return type is `any` → dynamic escape.
  if (ts.isReturnStatement(parent)) {
    return "neutral"; // S1 conservative: a returned instance's downstream use is
    // not tracked single-level; treat as neutral (does not approve, does not trip B).
  }

  // Everything else (identity compare, `typeof inst`, assignment source, etc.)
  // is neutral — it neither requires the $proto walk nor forces a typed field.
  return "neutral";
}

function isAnyOrUnknown(t: ts.Type): boolean {
  return (t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
}

/**
 * Find the binding symbol a `new F()` instance flows into, if it is the
 * initializer of a `const`/`let`/`var` declaration. S1 tracks this single,
 * dominant binding form (`const c = new F()`); an instance used inline
 * (`new F().foo`) is classified directly at the NewExpression's parent. Deeper
 * alias flow (reassignment, field-store-then-load) is a fuller-pass concern;
 * S1's conservative default keeps such sites.
 */
function bindingOf(newExpr: ts.NewExpression): ts.Identifier | undefined {
  const parent = newExpr.parent;
  if (ts.isVariableDeclaration(parent) && parent.initializer === newExpr && ts.isIdentifier(parent.name)) {
    return parent.name;
  }
  // (#3719) A plain ASSIGNMENT to an identifier binds exactly as a declaration
  // initializer does — `var p; p = new F()` and `p = new F()` after some other
  // initializer are the same flow as `var p = new F()`.
  //
  // Recognising only the declaration form silently mis-classified every other
  // shape. With no binding, classification fell to the inline branch, saw no
  // property access directly on the `new`, and settled on `keep-static` — so
  // the class never entered `approvedNames`, its prototype methods were never
  // lifted or compiled, and a later `p.m()` resolved to NOTHING at runtime:
  //
  //     function Q(){ this.v = 9; }
  //     Q.prototype.inc = function () { return 1000; };
  //     var p; p = new Q(); p.inc();     // -> undefined, silently
  //
  // Adding ANY separate typed use (even a dead one) put the class in
  // `approvedNames` and made the same call work, which is what pinned the
  // cause here rather than in dispatch. Returning the assignment target lets
  // the normal use-walk classify it: an own-field consumer still yields
  // `keep-typed` (the fast path is preserved), a method call yields
  // `reconstruct`.
  if (
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    parent.right === newExpr &&
    ts.isIdentifier(parent.left)
  ) {
    return parent.left;
  }
  return undefined;
}

// ── #2660 PART-1 — receiver-struct flow map (single-return inference) ─────────

/** Unwrap `( … )` / `as` / `!` wrappers around an expression. */
function unwrapExpr(e: ts.Expression): ts.Expression {
  let cur = e;
  while (ts.isParenthesizedExpression(cur) || ts.isAsExpression(cur) || ts.isNonNullExpression(cur)) {
    cur = (cur as ts.ParenthesizedExpression | ts.AsExpression | ts.NonNullExpression).expression;
  }
  return cur;
}

/** True for any function-like node that can carry a `return`-bearing body. */
function isFunctionLike(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node)
  );
}

/**
 * #3683 S1 — prototype-method write-once analysis (see
 * {@link ProtoMethodWriteOnceResult} for the contract). Purely syntactic and
 * whole-source-file; no checker, no codegen, no side effects.
 */
export function analyzeProtoMethodWriteOnce(sourceFile: ts.SourceFile): ProtoMethodWriteOnceResult {
  const aliasToOwner = new Map<string, string>(); // "pp$8" → "Parser"
  const collidingAliases = new Set<string>();
  const poisoned = new Set<string>();
  const writes = new Map<string, Map<string, { decl?: ts.FunctionLikeDeclaration; bad: boolean }>>();
  // (#3683 S1b) direct-call admission facts.
  let otherNameWrites: Set<string> | null = new Set<string>();
  const inheritedFrom = new Set<string>();
  const runtimeDefined = new Map<string, Set<string>>();

  // Pass 1 — top-level `var pp = F.prototype;` aliases. A name declared twice
  // for DIFFERENT owners is ambiguous: poison both owners and drop the alias.
  for (const stmt of sourceFile.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const d of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(d.name) || !d.initializer) continue;
      const init = unwrapExpr(d.initializer);
      if (ts.isPropertyAccessExpression(init) && init.name.text === "prototype" && ts.isIdentifier(init.expression)) {
        const owner = init.expression.text;
        const prev = aliasToOwner.get(d.name.text);
        if (prev !== undefined && prev !== owner) {
          poisoned.add(prev);
          poisoned.add(owner);
          collidingAliases.add(d.name.text);
        }
        aliasToOwner.set(d.name.text, owner);
      }
    }
  }
  for (const name of collidingAliases) aliasToOwner.delete(name);

  const ownerOfBase = (base: ts.Expression): string | undefined => {
    const b = unwrapExpr(base);
    if (ts.isPropertyAccessExpression(b) && b.name.text === "prototype" && ts.isIdentifier(b.expression)) {
      return b.expression.text;
    }
    if (ts.isIdentifier(b)) return aliasToOwner.get(b.text);
    return undefined;
  };

  /** `Symbol.<wellKnown>` computed-key test — symbol keys cannot collide
   *  with the string-keyed method slots this analysis reasons about. */
  const isSymbolKeyed = (idx: ts.Expression | undefined): boolean => {
    if (idx === undefined) return false;
    const e = unwrapExpr(idx);
    return ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === "Symbol";
  };

  // A prototype value handed to these in ARGUMENT position is read, not
  // mutated — the one escape shape acorn-style inheritance actually uses.
  const isNonMutatingProtoConsumer = (call: ts.CallExpression): boolean => {
    const callee = unwrapExpr(call.expression);
    if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.expression)) return false;
    if (callee.expression.text !== "Object") return false;
    return callee.name.text === "create" || callee.name.text === "getPrototypeOf";
  };

  /** `Object.defineProperties` / `Object.defineProperty` callee test. */
  const objectDefineKind = (call: ts.CallExpression): "many" | "one" | undefined => {
    const callee = unwrapExpr(call.expression);
    if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.expression)) return undefined;
    if (callee.expression.text !== "Object") return undefined;
    if (callee.name.text === "defineProperties") return "many";
    if (callee.name.text === "defineProperty") return "one";
    return undefined;
  };

  /** Own-key names of an object literal, or undefined on computed/spread. */
  const keysOfLiteral = (lit: ts.ObjectLiteralExpression): Set<string> | undefined => {
    const keys = new Set<string>();
    for (const prop of lit.properties) {
      if (ts.isSpreadAssignment(prop)) return undefined;
      const name = prop.name;
      if (name === undefined) return undefined;
      if (ts.isIdentifier(name) || ts.isStringLiteral(name)) keys.add(name.text);
      else if (ts.isNumericLiteral(name)) keys.add(name.text);
      else return undefined; // computed key
    }
    return keys;
  };

  /**
   * Resolve the descriptor-map argument of `Object.defineProperties(proto, X)`
   * to its full possible key set: an inline object literal, or an identifier
   * declared exactly once at top level with an object-literal initializer
   * (acorn's `prototypeAccessors` pattern). Depth-1 property WRITES `X.k = …`
   * anywhere widen the set (they add keys before the call); any other use of
   * `X` beyond property access / the defineProperties argument position makes
   * the set unresolvable (undefined → caller poisons).
   */
  const resolveDescriptorKeys = (arg: ts.Expression): Set<string> | undefined => {
    const a = unwrapExpr(arg);
    if (ts.isObjectLiteralExpression(a)) return keysOfLiteral(a);
    if (!ts.isIdentifier(a)) return undefined;
    let init: ts.ObjectLiteralExpression | undefined;
    let declCount = 0;
    for (const stmt of sourceFile.statements) {
      if (!ts.isVariableStatement(stmt)) continue;
      for (const d of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || d.name.text !== a.text) continue;
        declCount++;
        const i = d.initializer !== undefined ? unwrapExpr(d.initializer) : undefined;
        init = i !== undefined && ts.isObjectLiteralExpression(i) ? i : undefined;
      }
    }
    if (declCount !== 1 || init === undefined) return undefined;
    const keys = keysOfLiteral(init);
    if (keys === undefined) return undefined;
    let ok = true;
    const scan = (n: ts.Node): void => {
      if (!ok) return;
      if (ts.isIdentifier(n) && n.text === a.text) {
        const p = n.parent;
        const asPropBase = p !== undefined && ts.isPropertyAccessExpression(p) && p.expression === n;
        const asOwnDecl = p !== undefined && ts.isVariableDeclaration(p) && p.name === n;
        const asDefineArg =
          p !== undefined && ts.isCallExpression(p) && objectDefineKind(p) === "many" && p.arguments[1] === n;
        if (asPropBase) {
          const gp = p.parent;
          if (
            gp !== undefined &&
            ts.isBinaryExpression(gp) &&
            gp.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            gp.left === p
          ) {
            keys.add(p.name.text); // depth-1 write adds a key
          }
        } else if (!asOwnDecl && !asDefineArg) {
          ok = false;
        }
      }
      forEachChild(n, scan);
    };
    scan(sourceFile);
    return ok ? keys : undefined;
  };

  /**
   * Handle `Object.defineProperties(proto, X)` / `Object.defineProperty(proto,
   * "k", …)` on a tracked prototype: demote exactly the resolvable key set
   * (they become non-write-once — a definePropertied slot is an accessor or a
   * redefined data prop), or poison the owner when the keys are unresolvable.
   */
  const handleObjectDefine = (call: ts.CallExpression): void => {
    const kind = objectDefineKind(call);
    if (kind === undefined || call.arguments.length < 2) return;
    const owner = ownerOfBase(call.arguments[0]!);
    if (owner === undefined) return;
    let demote: Set<string> | undefined;
    if (kind === "one") {
      const key = unwrapExpr(call.arguments[1]!);
      demote = ts.isStringLiteral(key) ? new Set([key.text]) : undefined;
    } else {
      demote = resolveDescriptorKeys(call.arguments[1]!);
    }
    if (demote === undefined) {
      poisoned.add(owner);
      return;
    }
    let perOwner = writes.get(owner);
    if (!perOwner) {
      perOwner = new Map();
      writes.set(owner, perOwner);
    }
    for (const key of demote) {
      perOwner.set(key, { bad: true });
      otherNameWrites?.add(key); // (#3683 S1b) definePropertied slots are written elsewhere
      let runtimeKeys = runtimeDefined.get(owner);
      if (!runtimeKeys) {
        runtimeKeys = new Set();
        runtimeDefined.set(owner, runtimeKeys);
      }
      runtimeKeys.add(key);
    }
  };

  const isUnconditionalTopLevel = (assignment: ts.Node): boolean =>
    assignment.parent !== undefined &&
    ts.isExpressionStatement(assignment.parent) &&
    assignment.parent.parent === sourceFile;

  const walk = (n: ts.Node): void => {
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const left = n.left;
      // `F.prototype = …` (incl. `Sub.prototype = Object.create(…)`) → poison F.
      if (ts.isPropertyAccessExpression(left) && left.name.text === "prototype" && ts.isIdentifier(left.expression)) {
        poisoned.add(left.expression.text);
      } else if (ts.isIdentifier(left) && aliasToOwner.has(left.text)) {
        // Alias variable reassigned → the tracked owner is unprovable.
        poisoned.add(aliasToOwner.get(left.text)!);
      } else if (ts.isPropertyAccessExpression(left)) {
        const owner = ownerOfBase(left.expression);
        if (owner === undefined) {
          // (#3683 S1b) a property write to a NON-prototype receiver: the name
          // is writable elsewhere — it can shadow / be redefined.
          otherNameWrites?.add(left.name.text);
        }
        if (owner !== undefined) {
          const rhs = unwrapExpr(n.right);
          let perOwner = writes.get(owner);
          if (!perOwner) {
            perOwner = new Map();
            writes.set(owner, perOwner);
          }
          const name = left.name.text;
          const prev = perOwner.get(name);
          if (prev !== undefined || !isFunctionLike(rhs) || !rhs.body || !isUnconditionalTopLevel(n)) {
            perOwner.set(name, { bad: true });
            otherNameWrites?.add(name); // (#3683 S1b) not the single admitted write
          } else {
            perOwner.set(name, { decl: rhs, bad: false });
          }
        }
      } else if (ts.isElementAccessExpression(left)) {
        const owner = ownerOfBase(left.expression);
        // A SYMBOL-keyed write (`pp[Symbol.iterator] = …`) cannot shadow a
        // string-keyed method slot — ignore it. Any other computed key is
        // unresolvable → poison the owner; and regardless of receiver, a
        // non-symbol computed member write can target ANY name (#3683 S1b).
        if (!isSymbolKeyed(left.argumentExpression)) {
          if (owner !== undefined) poisoned.add(owner);
          if (ts.isStringLiteral(unwrapExpr(left.argumentExpression))) {
            otherNameWrites?.add((unwrapExpr(left.argumentExpression) as ts.StringLiteral).text);
          } else {
            otherNameWrites = null; // dynamic key — any name writable
          }
        }
      }
    }
    if (ts.isDeleteExpression(n)) {
      const t = unwrapExpr(n.expression);
      if (ts.isPropertyAccessExpression(t) || ts.isElementAccessExpression(t)) {
        const owner = ownerOfBase(t.expression);
        const symbolKeyed = ts.isElementAccessExpression(t) && isSymbolKeyed(t.argumentExpression);
        if (owner !== undefined && !symbolKeyed) poisoned.add(owner);
      }
    }
    // Precise defineProperties/defineProperty handling (demote resolvable
    // keys; poison on unresolvable) — the generic classifiers below then
    // ALLOW the arg0 position for these calls.
    if (ts.isCallExpression(n)) handleObjectDefine(n);
    // (#3683 S1b) `Object.create(F.prototype)` — F is inherited from.
    if (ts.isCallExpression(n) && isNonMutatingProtoConsumer(n) && n.arguments.length >= 1) {
      const owner = ownerOfBase(n.arguments[0]!);
      if (owner !== undefined) inheritedFrom.add(owner);
    }
    const isDefineArg0 = (p: ts.Node | undefined, node: ts.Node): boolean =>
      p !== undefined && ts.isCallExpression(p) && objectDefineKind(p) !== undefined && p.arguments[0] === node;
    // Generic escape classification of every reference to a tracked prototype
    // VALUE. Allowed shapes: base of a property access (read or the write
    // handled above), the alias's own declaration, the assignment-target
    // positions handled above, the whitelisted non-mutating call args, and
    // the precisely-handled defineProperties/defineProperty target position.
    if (ts.isIdentifier(n) && aliasToOwner.has(n.text)) {
      const p = n.parent;
      const allowed =
        (p !== undefined && ts.isVariableDeclaration(p) && p.name === n) ||
        (p !== undefined && ts.isPropertyAccessExpression(p) && p.expression === n) ||
        (p !== undefined &&
          ts.isBinaryExpression(p) &&
          p.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          p.left === n) ||
        (p !== undefined && ts.isElementAccessExpression(p) && p.expression === n) ||
        (p !== undefined &&
          ts.isCallExpression(p) &&
          p.arguments.some((a) => a === n) &&
          isNonMutatingProtoConsumer(p)) ||
        isDefineArg0(p, n);
      if (!allowed) poisoned.add(aliasToOwner.get(n.text)!);
    }
    if (ts.isPropertyAccessExpression(n) && n.name.text === "prototype" && ts.isIdentifier(n.expression)) {
      const p = n.parent;
      const allowed =
        (p !== undefined && ts.isPropertyAccessExpression(p) && p.expression === n) ||
        (p !== undefined && ts.isElementAccessExpression(p) && p.expression === n) ||
        (p !== undefined &&
          ts.isVariableDeclaration(p) &&
          p.initializer !== undefined &&
          unwrapExpr(p.initializer) === n) ||
        (p !== undefined &&
          ts.isBinaryExpression(p) &&
          p.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          p.left === n) ||
        (p !== undefined &&
          ts.isCallExpression(p) &&
          p.arguments.some((a) => a === n) &&
          isNonMutatingProtoConsumer(p)) ||
        isDefineArg0(p, n);
      if (!allowed) poisoned.add(n.expression.text);
    }
    forEachChild(n, walk);
  };
  walk(sourceFile);

  const methods = new Map<string, ReadonlyMap<string, ts.FunctionLikeDeclaration>>();
  for (const [owner, perOwner] of writes) {
    if (poisoned.has(owner)) continue;
    const m = new Map<string, ts.FunctionLikeDeclaration>();
    for (const [name, v] of perOwner) {
      if (!v.bad && v.decl) m.set(name, v.decl);
    }
    if (m.size > 0) methods.set(owner, m);
  }
  return { methods, poisoned, otherNameWrites, inheritedFrom, runtimeDefined };
}

/**
 * A program-wide index `methodName → FunctionLike[]` of expando method
 * assignments `<obj>.<name> = function(){…}` (the acorn aliased-prototype form
 * `pp.m = function(){…}`, and `Class.prototype.m = function(){…}`). Used as the
 * callee-resolution FALLBACK when the type-checker cannot resolve a
 * `this.<name>()` / `recv.<name>()` callee — which is the COMMON case here: the
 * checker types acorn's lifted-method `this` / the call result as `any` (the
 * whole reason #2660 exists), so symbol resolution of `this.startNode` fails. A
 * name with exactly ONE indexed body resolves unambiguously; a colliding name
 * (≥2 bodies) is left unresolved (conservative — never a wrong callee).
 */
type ProtoMethodIndex = ReadonlyMap<string, ts.FunctionLikeDeclaration[]>;

function buildProtoMethodIndex(sourceFile: ts.SourceFile): ProtoMethodIndex {
  const idx = new Map<string, ts.FunctionLikeDeclaration[]>();
  const walk = (n: ts.Node): void => {
    if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(n.left)
    ) {
      const rhs = unwrapExpr(n.right);
      if (isFunctionLike(rhs)) {
        const name = n.left.name.text;
        const arr = idx.get(name);
        if (arr) arr.push(rhs);
        else idx.set(name, [rhs]);
      }
    }
    forEachChild(n, walk);
  };
  walk(sourceFile);
  return idx;
}

/**
 * Resolve a method/function call's callee to the function-like declaration that
 * supplies its body. Tries the type-checker symbol first (precise when it
 * resolves), then falls back to the syntactic {@link ProtoMethodIndex} for the
 * acorn-dominant `this.<name>()` / `recv.<name>()` form the checker leaves `any`.
 * Handles plain `function f(){…}`, `var f = function(){…}`, object/class methods,
 * `{ m() {} }` / `{ m: function(){} }`, and the aliased-prototype
 * `var pp = Class.prototype; pp.m = function(){…}` assignment. Returns `undefined`
 * when ambiguous (a name with ≥2 indexed bodies) — conservative, never a wrong
 * callee.
 */
function resolveCalleeFunction(
  checker: ts.TypeChecker,
  callExpr: ts.CallExpression,
  protoIndex: ProtoMethodIndex,
): ts.FunctionLikeDeclaration | undefined {
  const callee = unwrapExpr(callExpr.expression);
  let sym: ts.Symbol | undefined;
  if (ts.isPropertyAccessExpression(callee)) {
    sym = checker.getSymbolAtLocation(callee.name) ?? checker.getSymbolAtLocation(callee);
  } else if (ts.isIdentifier(callee)) {
    sym = checker.getSymbolAtLocation(callee);
  }
  if (sym) {
    for (const decl of sym.getDeclarations() ?? []) {
      const fn = functionFromDeclaration(decl);
      if (fn?.body) return fn;
    }
  }
  // Checker miss → syntactic prototype-method fallback (unique name only).
  if (ts.isPropertyAccessExpression(callee)) {
    const cands = protoIndex.get(callee.name.text);
    if (cands && cands.length === 1 && cands[0]!.body) return cands[0];
  }
  return undefined;
}

/** Extract the FunctionLike body-bearer a declaration node defines, if any. */
function functionFromDeclaration(decl: ts.Declaration): ts.FunctionLikeDeclaration | undefined {
  if (isFunctionLike(decl)) return decl;
  // `var f = function(){…}` / `var f = () => …`
  if (ts.isVariableDeclaration(decl) && decl.initializer) {
    const init = unwrapExpr(decl.initializer);
    if (isFunctionLike(init)) return init;
    return undefined;
  }
  // `{ m: function(){…} }` / `{ m() {} }`
  if (ts.isPropertyAssignment(decl)) {
    const init = unwrapExpr(decl.initializer);
    if (isFunctionLike(init)) return init;
    return undefined;
  }
  if (ts.isMethodDeclaration(decl)) return decl;
  // `pp.m = function(){…}` — the symbol's declaration is the LHS PropertyAccess;
  // its BinaryExpression parent's RHS is the function.
  if (ts.isPropertyAccessExpression(decl) || ts.isElementAccessExpression(decl)) {
    const parent = decl.parent;
    if (
      ts.isBinaryExpression(parent) &&
      parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      parent.left === decl
    ) {
      const rhs = unwrapExpr(parent.right);
      if (isFunctionLike(rhs)) return rhs;
    }
  }
  return undefined;
}

/** The single `return <expr>` of a function body, or `undefined` if not exactly one. */
function singleReturnExpr(fn: ts.FunctionLikeDeclaration): ts.Expression | undefined {
  const body = fn.body;
  if (!body) return undefined;
  // Arrow with an expression body: `() => new Node()`.
  if (!ts.isBlock(body)) return body;
  const returns: ts.Expression[] = [];
  const walk = (n: ts.Node): void => {
    if (ts.isReturnStatement(n)) {
      if (n.expression) returns.push(n.expression);
      return;
    }
    // Do NOT descend into nested functions — their returns are not ours.
    if (isFunctionLike(n)) return;
    forEachChild(n, walk);
  };
  walk(body);
  return returns.length === 1 ? returns[0] : undefined;
}

/**
 * Infer the `__fnctor_<Name>` struct a function's SINGLE return yields, if any.
 * Follows `return new X()` directly and `return <single-return call>` chains
 * (depth-capped + memoized against recursion). Returns `undefined` when the
 * single return is anything else, when there is not exactly one return, or when
 * the chain exceeds the depth cap — conservative-closed, never a wrong struct.
 */
function inferReturnStruct(
  checker: ts.TypeChecker,
  fn: ts.FunctionLikeDeclaration,
  depth: number,
  memo: Map<ts.FunctionLikeDeclaration, string | undefined>,
  protoIndex: ProtoMethodIndex,
): string | undefined {
  if (memo.has(fn)) return memo.get(fn);
  if (depth <= 0) return undefined;
  // Tentative `undefined` guards against self-recursive chains resolving to junk.
  memo.set(fn, undefined);
  const ret = singleReturnExpr(fn);
  let result: string | undefined;
  if (ret) {
    const r = unwrapExpr(ret);
    if (ts.isNewExpression(r)) {
      let ctorSym = resolveFnctorSymbol(checker, r.expression);
      // #2681/#2686 — `return new this()` in a fnctor static method resolves to
      // the enclosing owner fnctor's struct.
      if (!ctorSym && r.expression.kind === ts.SyntaxKind.ThisKeyword) {
        ctorSym = resolveEnclosingFnctorOwner(checker, r)?.sym;
      }
      if (ctorSym) result = `__fnctor_${ctorSym.name}`;
    } else if (ts.isCallExpression(r)) {
      const callee = resolveCalleeFunction(checker, r, protoIndex);
      if (callee) result = inferReturnStruct(checker, callee, depth - 1, memo, protoIndex);
    }
    // `return this.field` / `return this.arr[i]` element-struct inference needs a
    // reliable element type (the checker types acorn's parser fields `any`), so it
    // is intentionally NOT attempted here — omission keeps the consumer on the
    // dynamic path (safe). A later slice can add a syntactic push-site scan.
  }
  memo.set(fn, result);
  return result;
}

/**
 * Build the #2660 PART-1 receiver-struct flow map: for every local binding
 * `const/let/var x = <call>` whose initializer call's single-return chain
 * resolves to a `__fnctor_<Name>` struct, map every USE identifier of `x` to
 * that struct name. Reuses the caller's symbol→uses index so it is a single
 * extra pass over the already-collected bindings.
 */
function buildReceiverStructMap(
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  usesBySymbol: ReadonlyMap<ts.Symbol, ts.Identifier[]>,
): Map<ts.Expression, string> {
  const map = new Map<ts.Expression, string>();
  const memo = new Map<ts.FunctionLikeDeclaration, string | undefined>();
  const protoIndex = buildProtoMethodIndex(sourceFile);
  const structBySymbol = new Map<ts.Symbol, string>();
  const declarations: ts.VariableDeclaration[] = [];
  const assignments: ts.BinaryExpression[] = [];
  const calls: ts.CallExpression[] = [];

  const indexFlowSites = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.name)) {
      declarations.push(node);
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    ) {
      assignments.push(node);
    }
    if (ts.isCallExpression(node)) calls.push(node);
    forEachChild(node, indexFlowSites);
  };
  indexFlowSites(sourceFile);

  const inferExprStruct = (expression: ts.Expression): string | undefined => {
    const expr = unwrapExpr(expression);
    if (ts.isIdentifier(expr)) {
      const sym = checker.getSymbolAtLocation(expr);
      return sym ? structBySymbol.get(sym) : undefined;
    }
    if (ts.isCallExpression(expr)) {
      const callee = resolveCalleeFunction(checker, expr, protoIndex);
      return callee ? inferReturnStruct(checker, callee, RETURN_INFER_MAX_DEPTH, memo, protoIndex) : undefined;
    }
    if (ts.isNewExpression(expr)) {
      // #2681/#2686 — `var p:any = new this()` in a fnctor static method: pin
      // `p`'s uses to the owner fnctor struct (read-dispatch case (2)).
      let ctorSym = resolveFnctorSymbol(checker, expr.expression);
      if (!ctorSym && expr.expression.kind === ts.SyntaxKind.ThisKeyword) {
        ctorSym = resolveEnclosingFnctorOwner(checker, expr)?.sym;
      }
      return ctorSym ? `__fnctor_${ctorSym.name}` : undefined;
    }
    // Acorn creates the Program node with
    // `options.program || this.startNode()`. The left side is either absent or
    // an API-supplied object with the same Program contract; pinning the known
    // constructor arm is safe because the member dispatcher retains its
    // generic `$Object` fallback for the supplied-object case.
    if (
      ts.isBinaryExpression(expr) &&
      (expr.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        expr.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
    ) {
      const left = inferExprStruct(expr.left);
      const right = inferExprStruct(expr.right);
      return left === right ? left : (left ?? right);
    }
    if (ts.isConditionalExpression(expr)) {
      const yes = inferExprStruct(expr.whenTrue);
      const no = inferExprStruct(expr.whenFalse);
      return yes === no ? yes : (yes ?? no);
    }
    return undefined;
  };

  const ambiguousSymbols = new Set<ts.Symbol>();
  const bind = (id: ts.Identifier, struct: string | undefined): boolean => {
    if (!struct) return false;
    const sym = checker.getSymbolAtLocation(id);
    if (!sym || ambiguousSymbols.has(sym)) return false;
    const current = structBySymbol.get(sym);
    if (current !== undefined) {
      if (current === struct) return false;
      // A parameter/local fed by more than one constructor shape cannot safely
      // grow fields on either concrete struct. Invalidate the first pin rather
      // than silently routing every later write to whichever call was visited
      // first (order-dependent cross-shape corruption).
      structBySymbol.delete(sym);
      ambiguousSymbols.add(sym);
      return true;
    }
    structBySymbol.set(sym, struct);
    return true;
  };

  // Propagate constructor identity through locals, assignments, and call
  // parameters to a fixed point. This carries `startNode() -> node ->
  // parseTopLevel(node)` and the equivalent ESTree builder chains without
  // guessing from variable names.
  let changed = true;
  let rounds = 0;
  while (changed && rounds++ < RETURN_INFER_MAX_DEPTH * 4) {
    changed = false;
    for (const decl of declarations) {
      changed = bind(decl.name as ts.Identifier, inferExprStruct(decl.initializer!)) || changed;
    }
    for (const assignment of assignments) {
      changed = bind(assignment.left as ts.Identifier, inferExprStruct(assignment.right)) || changed;
    }
    for (const call of calls) {
      const callee = resolveCalleeFunction(checker, call, protoIndex);
      if (!callee) continue;
      const count = Math.min(call.arguments.length, callee.parameters.length);
      for (let i = 0; i < count; i++) {
        const param = callee.parameters[i];
        if (!param || !ts.isIdentifier(param.name)) continue;
        changed = bind(param.name, inferExprStruct(call.arguments[i]!)) || changed;
      }
    }
  }

  for (const [sym, struct] of structBySymbol) {
    for (const use of usesBySymbol.get(sym) ?? []) map.set(use, struct);
  }
  return map;
}

/**
 * #2660 PART-1 — resolve the WasmGC struct a member-access RECEIVER expression
 * concretely is, for the dynamic read/write/compound dispatch to PIN to.
 *
 * Resolution order (the consumer pins to the first hit; a miss ⇒ dynamic path):
 *   1. `this` receiver → `fctx.thisStructName` (the #2681 syntactic prototype
 *      resolver's result, populated by the PART-2 dispatch slice);
 *   2. a local receiver in the {@link FnctorEscapeGateResult.receiverStruct} flow
 *      map (bound from a single-return-inferable fnctor call);
 *   3. otherwise `undefined` → the consumer keeps its existing dynamic
 *      (`__extern_get` / open-scan) lowering.
 *
 * **Conservative-closed**: a returned name is additionally gated on
 * `ctx.structMap.has(name)`, so a struct not (yet) registered at the call site
 * yields `undefined` rather than a dangling pin — a miss NEVER produces a wrong
 * struct. **INERT in PART-1**: exported for the PART-2 dispatch to consume; no
 * lowering calls it yet, so emitted Wasm is byte-identical.
 */
export function resolveReceiverStruct(
  ctx: CodegenContext,
  fctx: FunctionContext,
  recvExpr: ts.Expression,
): string | undefined {
  const recv = unwrapExpr(recvExpr);
  let name: string | undefined;
  if (recv.kind === ts.SyntaxKind.ThisKeyword) {
    name = fctx.thisStructName;
  } else {
    name = ctx.fnctorEscapeGate?.receiverStruct.get(recv);
  }
  if (name !== undefined && ctx.structMap.has(name)) return name;
  return undefined;
}

/**
 * #2660 S1 — classify every `new F()` fnctor site in the program.
 *
 * @param checker     the program type checker
 * @param sourceFile  the (already import-preprocessed) module source
 * @returns a frozen {@link FnctorEscapeGateResult}; empty when no fnctor `new`
 *          sites exist (so the pass is a no-op for class-only / fnctor-free code).
 */
export function analyzeFnctorEscapeGate(checker: ts.TypeChecker, sourceFile: ts.SourceFile): FnctorEscapeGateResult {
  const sites = new Map<ts.NewExpression, FnctorGateClass>();
  const approved = new Set<ts.NewExpression>();
  const approvedNames = new Set<string>();

  // 1. Collect every `new F()` whose callee is a fnctor.
  const newSites: { newExpr: ts.NewExpression; ctorSym: ts.Symbol }[] = [];
  // #2681/#2686 — `new this(…)` sites inside a fnctor static/prototype method
  // (acorn instantiates Parser ONLY this way). The callee is `this`, not an
  // identifier, so `resolveFnctorSymbol` misses; resolve the enclosing owner
  // fnctor instead. These are ALWAYS classified `reconstruct` (the instance is
  // consumed dynamically via `this.<field>` across the fnctor's lifted methods;
  // the read/write dispatch (#2664/#2674 + A3) routes those onto the native
  // struct, so clause B's `__extern_get`-regression concern does not apply).
  const newThisSites = new Set<ts.NewExpression>();
  const collect = (node: ts.Node): void => {
    if (ts.isNewExpression(node)) {
      let ctorSym = resolveFnctorSymbol(checker, node.expression);
      if (!ctorSym && node.expression.kind === ts.SyntaxKind.ThisKeyword) {
        const owner = resolveEnclosingFnctorOwner(checker, node);
        if (owner) {
          ctorSym = owner.sym;
          newThisSites.add(node);
        }
      }
      if (ctorSym) newSites.push({ newExpr: node, ctorSym });
    }
    forEachChild(node, collect);
  };
  collect(sourceFile);
  if (newSites.length === 0) return EMPTY_RESULT;

  // #2773 S1 — index fnctor name → declaration (first-seen wins, deterministic by
  // source order) for the up-front struct-type reservation pass.
  const ctorDeclByName = new Map<string, ts.FunctionDeclaration | ts.FunctionExpression>();
  for (const { ctorSym } of newSites) {
    if (ctorDeclByName.has(ctorSym.name)) continue;
    const decl = fnctorDeclFromSymbol(ctorSym);
    if (decl) ctorDeclByName.set(ctorSym.name, decl);
  }

  // 2. Build a per-binding-symbol index of identifier uses across the program,
  //    so a `const c = new F()` instance's uses can be found by symbol identity.
  const usesBySymbol = new Map<ts.Symbol, ts.Identifier[]>();
  const indexUses = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      const sym = checker.getSymbolAtLocation(node);
      if (sym) {
        const arr = usesBySymbol.get(sym);
        if (arr) arr.push(node);
        else usesBySymbol.set(sym, [node]);
      }
    }
    forEachChild(node, indexUses);
  };
  indexUses(sourceFile);

  // #2773 S2b — fnctor NAMES that own a reconstruct-classified `new this()` site
  // (acorn's Parser). Populated during classification below; the #2773 S1 up-front
  // reservation pass (`reserveFnctorStructTypes`) unions this with `approvedNames`
  // so the owner gets a reserved `$__fnctor_<F>` slot with a pass-invariant typeIdx.
  // A `new this()` owner also lands in `approvedNames` (it is always `reconstruct`),
  // so this set is a robustness/intent contract — the union is idempotent.
  const newThisOwnerNames = new Set<string>();

  // 3. Classify each site.
  for (const { newExpr, ctorSym } of newSites) {
    const ownFields = collectFnctorOwnFields(ctorSym);
    let sawDynamic = false;
    let sawTyped = false;

    const bind = bindingOf(newExpr);
    if (bind) {
      // Classify every use of the binding symbol.
      const bindSym = checker.getSymbolAtLocation(bind);
      const uses = bindSym ? (usesBySymbol.get(bindSym) ?? []) : [];
      for (const use of uses) {
        if (use === bind) continue; // the declaration name itself
        const c = classifyUse(checker, use, ownFields);
        if (c === "typed") sawTyped = true;
        else if (c === "dynamic") sawDynamic = true;
      }
    } else {
      // Inline `new F().X` — classify the single immediate consuming use,
      // unwrapping any `( … )` / `as` / `!` wrappers between the NewExpression
      // and its consumer (`(new Con()).x` has a ParenthesizedExpression parent).
      let inner: ts.Expression = newExpr;
      let parent = inner.parent;
      while (ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent) || ts.isNonNullExpression(parent)) {
        inner = parent;
        parent = parent.parent;
      }
      if (ts.isPropertyAccessExpression(parent) && parent.expression === inner) {
        if (ownFields.has(parent.name.text)) sawTyped = true;
        else sawDynamic = true;
      } else if (ts.isElementAccessExpression(parent) && parent.expression === inner) {
        sawDynamic = true;
      } else if (
        ts.isBinaryExpression(parent) &&
        parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        parent.right === inner &&
        (ts.isPropertyAccessExpression(parent.left) || ts.isElementAccessExpression(parent.left))
      ) {
        // `return table[key] = new F()` is Acorn's keyword-token factory shape.
        // The constructed value escapes through an open object table, so keep
        // its carrier dynamic across both the assignment result and later read.
        sawDynamic = true;
      } else if (
        ts.isCallExpression(parent) &&
        parent.arguments.length > 0 &&
        parent.arguments[0] === inner &&
        ts.isPropertyAccessExpression(parent.expression) &&
        GENERIC_METHOD_CALL.has(parent.expression.name.text)
      ) {
        // `some.call(new F(), …)` inline receiver.
        sawDynamic = true;
      }
      // any other inline use → neither; stays keep-static.
    }

    // Clause (B) is absolute: ANY typed own-field consumer ⇒ keep-typed (never
    // reconstruct — hot-path protection). Only then does clause (A) gate the
    // reconstruct/keep-static split. EXCEPTION (#2681/#2686): a `new this()`
    // site is always `reconstruct` — the parser instance is consumed
    // dynamically via `this.<field>` across the fnctor's lifted methods, and A1
    // (native struct) + A3 (struct read-dispatch) keep its typed-field reads on
    // `struct.get`, so clause B's `__extern_get`-regression does not apply.
    let cls: FnctorGateClass;
    if (newThisSites.has(newExpr)) cls = "reconstruct";
    else if (sawTyped) cls = "keep-typed";
    else if (sawDynamic) cls = "reconstruct";
    else cls = "keep-static";

    sites.set(newExpr, cls);
    if (cls === "reconstruct") {
      approved.add(newExpr);
      approvedNames.add(ctorSym.name);
      // (#2773 S2b) record the owner of a `new this()` reconstruct site.
      if (newThisSites.has(newExpr)) newThisOwnerNames.add(ctorSym.name);
    }
  }

  // 4. (#2660 PART-1) Build the receiver-struct flow map for local bindings whose
  //    initializer is a single-return-inferable fnctor-returning call. Reuses the
  //    symbol→uses index from step 2. INERT — stored for the PART-2 dispatch.
  const receiverStruct = buildReceiverStructMap(checker, sourceFile, usesBySymbol);

  // 5. Optional inert logging (no effect on output).
  if (process.env.JS2WASM_LOG_FNCTOR_GATE === "1" && (sites.size > 0 || receiverStruct.size > 0)) {
    const counts = { reconstruct: 0, "keep-typed": 0, "keep-static": 0 };
    for (const c of sites.values()) counts[c]++;
    // eslint-disable-next-line no-console
    console.error(
      `[#2660 fnctor-escape-gate] ${sites.size} new F() site(s): ` +
        `reconstruct=${counts.reconstruct} keep-typed=${counts["keep-typed"]} keep-static=${counts["keep-static"]}; ` +
        `receiverStruct flow-map entries=${receiverStruct.size}`,
    );
  }

  return {
    sites,
    approved,
    approvedNames,
    receiverStruct,
    newThisOwnerNames,
    ctorDeclByName,
    // (#3683 S1) inert write-once verdicts — consumed by the S2 typed-twin
    // emission, no lowering reads them yet.
    protoMethodWriteOnce: analyzeProtoMethodWriteOnce(sourceFile),
  };
}

/**
 * #2773 S1 (keystone) — derive the WasmGC field shape of a fnctor's
 * `$__fnctor_<Name>` struct from its constructor body's `this.<field> = …`
 * assignments. This is the **single source of truth** for the field set,
 * EXTRACTED verbatim from the on-demand inline logic that lived in
 * `compileNewFunctionDeclaration` (new-super.ts) so both the up-front reservation
 * pass and the legacy on-demand fallback produce the SAME shape — divergent field
 * order would give `struct.new` a different arity than the reserved type and trap.
 *
 * Mirrors the original logic exactly:
 *   - collects EVERY `this.<field>` LHS across (possibly CHAINED) assignments
 *     (`this.a = this.b = expr`), recursing into if/else and loop blocks;
 *   - prefers the RHS type when the LHS is `any` (externref) — the RHS carries the
 *     concrete type (e.g. number → f64);
 *   - widens non-null `ref` fields to `ref_null` so `struct.new`'s `ref.null`
 *     default-init is well-typed (a struct.new can't default a non-null ref).
 *
 * @param ctx      codegen context (for the checker + `resolveWasmType`)
 * @param funcDecl the fnctor's function-like declaration (its body is read)
 * @returns the ordered field set, or `[]` for a body-less / empty-body fnctor.
 */
export function deriveFnctorFields(
  ctx: CodegenContext,
  funcDecl: ts.FunctionDeclaration | ts.FunctionExpression,
): FieldDef[] {
  const body = funcDecl.body;
  if (!body) return [];

  const fields: FieldDef[] = [];
  const onlyConditional = new Map<string, boolean>();

  // Record one `this.<field>` slot from an assignment whose LHS is `this.<field>`.
  // `valueExpr` is the value being assigned to THAT field (for type inference) —
  // for a chained `this.a = this.b = expr`, the value flowing into `this.a` is the
  // whole `this.b = expr` sub-assignment (whose result type === expr's type).
  function recordThisField(lhs: ts.PropertyAccessExpression, valueExpr: ts.Expression, conditional: boolean): void {
    const fieldName = lhs.name.text;
    const existing = fields.find((f) => f.name === fieldName);
    if (existing) {
      if (!conditional) onlyConditional.set(fieldName, false);
      return;
    }
    // Prefer the RHS type — when `this` is `any`, the LHS type is also `any`
    // (externref), but the RHS has concrete type info (e.g., number → f64).
    const lhsType = ctx.checker.getTypeAtLocation(lhs);
    const rhsType = ctx.checker.getTypeAtLocation(valueExpr);
    const lhsWasm = resolveWasmType(ctx, lhsType);
    const rhsWasm = resolveWasmType(ctx, rhsType);
    let carrierExpr = valueExpr;
    while (ts.isBinaryExpression(carrierExpr) && carrierExpr.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      carrierExpr = carrierExpr.right;
    }
    const carrierType = ctx.checker.getTypeAtLocation(carrierExpr);
    const carrierWasm = resolveWasmType(ctx, carrierType);
    const carrierIsDynamicObjectCall =
      ts.isCallExpression(carrierExpr) &&
      ts.isIdentifier(carrierExpr.expression) &&
      ctx.dynamicObjectReturnFunctions.has(carrierExpr.expression.text);
    // A computed-key-populated empty object is deliberately represented by the
    // open `$Object` externref carrier. The checker's evolved `this.options`
    // LHS can still look like a closed anonymous shape; preferring it would
    // cast `getOptions(options)` to null at the constructor assignment. The
    // early carrier scan records the RHS return type before fnctor reservation,
    // so let that proven dynamic representation override the nominal LHS.
    const fieldType = carrierIsDynamicObjectCall
      ? ({ kind: "externref" } as const)
      : ctx.objectHashConsumerTypes.has(rhsType) || ctx.objectHashConsumerTypes.has(carrierType)
        ? carrierWasm
        : lhsWasm.kind === "externref"
          ? rhsWasm
          : lhsWasm;
    fields.push({ name: fieldName, type: fieldType, mutable: true });
    onlyConditional.set(fieldName, conditional);
  }
  // Walk an assignment EXPRESSION, collecting EVERY `this.<field>` LHS in a
  // (possibly CHAINED) assignment — `this.start = this.end = this.pos`, etc.
  function collectAssignmentChain(expr: ts.Expression, conditional: boolean): void {
    if (
      ts.isBinaryExpression(expr) &&
      expr.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(expr.left) &&
      expr.left.expression.kind === ts.SyntaxKind.ThisKeyword
    ) {
      recordThisField(expr.left, expr.right, conditional);
      // The RHS may itself be `this.<field> = …` (chained) — recurse to collect it.
      collectAssignmentChain(expr.right, conditional);
    }
  }
  function collectAssignmentNames(expr: ts.Expression, names: Set<string>): void {
    if (
      ts.isBinaryExpression(expr) &&
      expr.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(expr.left) &&
      expr.left.expression.kind === ts.SyntaxKind.ThisKeyword
    ) {
      names.add(expr.left.name.text);
      collectAssignmentNames(expr.right, names);
    }
  }
  function guaranteedAssignmentsInClosedStatement(stmt: ts.Statement): Set<string> | undefined {
    if (ts.isExpressionStatement(stmt)) {
      const names = new Set<string>();
      collectAssignmentNames(stmt.expression, names);
      return names;
    }
    if (ts.isEmptyStatement(stmt)) return new Set();
    if (ts.isBlock(stmt)) {
      const names = new Set<string>();
      for (const child of stmt.statements) {
        const childNames = guaranteedAssignmentsInClosedStatement(child);
        if (childNames === undefined) return undefined;
        for (const name of childNames) names.add(name);
      }
      return names;
    }
    if (ts.isIfStatement(stmt) && stmt.elseStatement) {
      const thenNames = guaranteedAssignmentsInClosedStatement(stmt.thenStatement);
      const elseNames = guaranteedAssignmentsInClosedStatement(stmt.elseStatement);
      if (thenNames === undefined || elseNames === undefined) return undefined;
      return new Set([...thenNames].filter((name) => elseNames.has(name)));
    }
    return undefined;
  }
  function containsConstructorReturn(stmt: ts.Statement): boolean {
    let found = false;
    const visit = (node: ts.Node): void => {
      if (found) return;
      if (node !== stmt && ts.isFunctionLike(node)) return;
      if (ts.isReturnStatement(node)) {
        found = true;
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(stmt);
    return found;
  }
  function guaranteedAssignmentsInStatements(stmts: ts.NodeArray<ts.Statement> | readonly ts.Statement[]): Set<string> {
    const names = new Set<string>();
    for (const stmt of stmts) {
      const statementNames = guaranteedAssignmentsInClosedStatement(stmt);
      if (statementNames !== undefined) {
        for (const name of statementNames) names.add(name);
      }
      // A constructor return can leave every later write unexecuted on one
      // successful construction path. Stop the proof at the first statement
      // that contains one; thrown/non-terminating paths produce no instance.
      if (containsConstructorReturn(stmt)) break;
    }
    return names;
  }
  function collectStatement(stmt: ts.Statement, conditional: boolean): void {
    if (ts.isExpressionStatement(stmt) && ts.isBinaryExpression(stmt.expression)) {
      collectAssignmentChain(stmt.expression, conditional);
    }
    if (ts.isBlock(stmt)) {
      collectThisAssignments(stmt.statements, conditional);
      return;
    }
    if (ts.isIfStatement(stmt)) {
      collectStatement(stmt.thenStatement, true);
      if (stmt.elseStatement) collectStatement(stmt.elseStatement, true);
      return;
    }
    if (
      ts.isForStatement(stmt) ||
      ts.isForInStatement(stmt) ||
      ts.isForOfStatement(stmt) ||
      ts.isWhileStatement(stmt) ||
      ts.isDoStatement(stmt)
    ) {
      collectStatement(stmt.statement, true);
    }
  }
  function collectThisAssignments(
    stmts: ts.NodeArray<ts.Statement> | readonly ts.Statement[],
    conditional = false,
  ): void {
    for (const stmt of stmts) {
      collectStatement(stmt, conditional);
    }
  }
  collectThisAssignments(body.statements);
  // Assignments in both arms of a complete `if/else` are definite even though
  // each individual arm is syntactically conditional. Do not allocate a
  // presence bit for those fields: every successfully constructed instance has
  // the slot. Acorn's Parser initializes `pos`, `lineStart`, and `curLine` this
  // way; treating `pos` as optional made lifted parser-method reads observe
  // `undefined` and reject otherwise-valid bare arrow functions.
  for (const name of guaranteedAssignmentsInStatements(body.statements)) {
    if (onlyConditional.has(name)) onlyConditional.set(name, false);
  }

  // Parser-style data constructors often establish only a small base shape in
  // the constructor and add variant fields later through builder methods. Acorn
  // is the canonical case: `new Node(...)` creates type/start/end, while flows
  // such as `startNode() -> node -> parseTopLevel(node)` later assign `body`,
  // `expression`, `left`, and the rest of the ESTree variant payload.
  //
  // The receiver-flow analysis above has already propagated those bindings and
  // parameters to a concrete `__fnctor_<Name>` candidate. Reserve every named
  // field assigned through that proven flow as an externref slot. The dynamic
  // carrier is deliberate: a field name such as `value` is heterogeneous across
  // ESTree variants. Every flow-grown field is presence-tracked because an
  // individual instance may never receive it.
  let flowStructName: string | undefined;
  for (const [name, decl] of ctx.fnctorEscapeGate?.ctorDeclByName ?? []) {
    if (decl === funcDecl) {
      flowStructName = `__fnctor_${name}`;
      break;
    }
  }
  // Host mode already has its fnctor sidecar for expando properties. Reserving
  // duplicate native slots there would shadow the sidecar during marshalling
  // while their presence bits remain unset. This native shape growth is the
  // host-free standalone replacement only.
  if (ctx.standalone && flowStructName) {
    for (const [receiver, structName] of ctx.fnctorEscapeGate?.receiverStruct ?? []) {
      if (structName !== flowStructName) continue;
      const access = receiver.parent;
      if (!ts.isPropertyAccessExpression(access) || access.expression !== receiver) continue;
      const assignment = access.parent;
      if (
        !ts.isBinaryExpression(assignment) ||
        assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
        assignment.left !== access
      ) {
        continue;
      }
      const fieldName = access.name.text;
      if (fields.some((field) => field.name === fieldName)) continue;
      fields.push({ name: fieldName, type: { kind: "externref" }, mutable: true });
      onlyConditional.set(fieldName, true);
    }
  }

  // (#3683 S4a) Promote provably-numeric slots from the boxed `externref`
  // carrier to a PHYSICAL f64. This is the value-representation half of the
  // typed-`this` work: S2 made `this.pos` inside a twin a bare `struct.get`,
  // but an externref field still hands back a boxed value the consumer has to
  // `__unbox_number`, so the twin removed the dispatcher CALL and none of the
  // BOXING. The field derives externref only because the FIRST constructor
  // write types it and acorn's is `this.pos = startPos` under `this: any`;
  // `analyzeNumericPropertyNames` replaces that one-write guess with a
  // whole-program "every write to this NAME is numeric" verdict.
  //
  // Three carve-outs, each matching a mechanism a raw f64 slot cannot express:
  //   - only `externref` fields are touched, so a slot the checker already
  //     typed (i32 booleans, ref carriers, existing f64) is left exactly as is;
  //   - presence-tracked (conditional-only, incl. every flow-grown) field keeps
  //     its carrier: the read dispatcher's presence check answers `undefined`,
  //     and the S2 twin declines those sites for the same reason;
  //   - accessor-backed names keep the dispatcher's accessor arm.
  // `numericPropertyNames` is populated in the standalone lane only.
  for (const field of fields) {
    if (field.type.kind !== "externref") continue;
    if (onlyConditional.get(field.name) === true) continue;
    if (!ctx.numericPropertyNames?.has(field.name)) continue;
    if (ctx.classAccessorSet.has(`${flowStructName}_${field.name}`)) continue;
    field.type = { kind: "f64" };
  }

  // (#3753 S1) The STRING half of the same promotion. A field whose every write
  // is provably a string (`ctx.stringPropertyNames`, the slot-aware verdict from
  // the same whole-program walk) carries a native `$AnyString` ref instead of the
  // boxed `externref`.
  //
  // The cost this removes is per-ACCESS, not per-write: reading a boxed slot
  // emits `any.convert_extern` + `ref.test` + `ref.cast` + `__str_flatten`
  // before the string is usable, so `this.input.charCodeAt(i)` in a scan loop
  // pays all four per character. #3753 measured that at 6.6x on the tokenizer
  // axis — the single largest remaining gap to node.
  //
  // Same three carve-outs as the numeric promotion above, for the same reasons
  // (already-typed slots are left alone; a presence-tracked field needs its
  // carrier to answer `undefined`; an accessor-backed name keeps the
  // dispatcher's accessor arm), plus two of its own:
  //   - the native string type must actually be registered (`anyStrTypeIdx`),
  //     since this runs during struct derivation and the type is lazy;
  //   - `nativeStrings` must be on, which is what makes `$AnyString` the
  //     module's string carrier at all.
  // `JS2WASM_STRING_FIELDS=0` reproduces the pre-#3753 field shapes exactly,
  // which is what makes a same-container A/B possible (mirrors S4a's
  // `JS2WASM_NUMERIC_FIELDS=0`).
  if (ctx.nativeStrings && ctx.anyStrTypeIdx >= 0 && process.env.JS2WASM_STRING_FIELDS !== "0") {
    for (const field of fields) {
      if (field.type.kind !== "externref") continue;
      if (onlyConditional.get(field.name) === true) continue;
      if (!ctx.stringPropertyNames?.has(field.name)) continue;
      if (ctx.classAccessorSet.has(`${flowStructName}_${field.name}`)) continue;
      field.type = { kind: "ref_null", typeIdx: ctx.anyStrTypeIdx };
    }
  }

  // Widen non-null ref fields to ref_null so struct.new can use ref.null defaults.
  // (Kept INSIDE the derivation so the reserved field set matches exactly what the
  // struct.new default-init loop expects — see new-super.ts.)
  for (const field of fields) {
    if (field.type.kind === "ref") {
      field.type = {
        kind: "ref_null",
        typeIdx: (field.type as { typeIdx: number }).typeIdx,
      };
    }
  }

  appendFnctorInternalFields(ctx, fields, onlyConditional);

  return fields;
}
