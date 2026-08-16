// Whole-program source-scanning predicates (#3104, extracted from index.ts).
//
// These are pure, cheap AST pre-scans over a `ts.SourceFile` that answer a
// single "does the program contain feature X anywhere" question. Each drives a
// byte-identity gate in `generateModule` / `generateMultiModule`: when the
// predicate is false (the common case) the corresponding feature path is never
// emitted, so unaffected modules produce byte-identical wasm. They live here,
// separate from the codegen mainline, because they share the same
// walk-until-found shape and have no dependency on `CodegenContext`.

import { ts, forEachChild } from "../ts-api.js";
import type { TypeOracle } from "../checker/oracle.js";
import { isStrictContext } from "./helpers/is-strict-function.js";
import { TYPED_ARRAY_NAMES } from "./index.js";

export function sourceContainsClass(sourceFile: ts.SourceFile): boolean {
  let found = false;
  function walk(node: ts.Node): void {
    if (found) return;
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      found = true;
      return;
    }
    forEachChild(node, walk);
  }
  walk(sourceFile);
  return found;
}

/**
 * (#4187) The single member-delete walk, answering both questions the module
 * setup asks: **whether** any member delete exists (#2179) and **which
 * identifiers** are deleted from.
 *
 * Fused, and `collectReceivers` is a COST switch, not a convenience. #2179's
 * boolean short-circuits on the first hit; collecting names cannot, because a
 * later statement may delete from a different receiver. Giving up that
 * short-circuit unconditionally cost **+3,847** on the #3437 harness
 * compile-work budget (111,568 → 115,415), which meters shared-helper
 * `forEachChild` invocations over a fixture whose prelude is prepended to all
 * ~43k test262 files. Since `memberDeleteReceiverNames` is read only by the
 * STANDALONE arm of the `hasOwnProperty` routing gate, host-mode callers pass
 * `false` and keep main's exact traversal — the budget fixture compiles in host
 * mode and returns to 111,568.
 *
 * @returns `any` — a `delete o.a` / `delete o[k]` occurs somewhere (a no-op
 *   `delete x` of a bare identifier does NOT count: it leaves no tombstone for
 *   the inline `struct.get` read fast-path to miss).
 * @returns `receiverNames` — see {@link scanModuleMemberDeletes}; empty
 *   when `collectReceivers` is false. A strict subset of what sets `any`:
 *   `delete a.b.c` and `delete f().x` have no identifier receiver, so they set
 *   `any` and contribute no name.
 */
function scanMemberDeletes(
  sourceFile: ts.SourceFile,
  collectReceivers: boolean,
): { any: boolean; receiverNames: Set<string> } {
  let anyDelete = false;
  const receiverNames = new Set<string>();
  function walk(node: ts.Node): void {
    // Short-circuit only when the names are not wanted — otherwise the walk
    // must run to completion to see every deleted-from receiver.
    if (anyDelete && !collectReceivers) return;
    if (ts.isDeleteExpression(node)) {
      const target = node.expression;
      if (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) {
        anyDelete = true;
        const receiver = target.expression;
        if (collectReceivers && ts.isIdentifier(receiver)) receiverNames.add(receiver.text);
        if (!collectReceivers) return;
      }
    }
    forEachChild(node, walk);
  }
  walk(sourceFile);
  return { any: anyDelete, receiverNames };
}

/**
 * Both member-delete answers from ONE walk — the module-setup entry point.
 * Pass `collectReceivers: false` outside `--target standalone`; nothing reads
 * the names there and the boolean-only walk short-circuits (see
 * {@link scanMemberDeletes} for the measured cost).
 *
 * ---
 *
 * (#2179) `any` is true when the source contains a `delete` operating on a
 * property or element access (`delete o.a` / `delete o[k]`). `delete x` of a
 * bare identifier and `delete <other expr>` (no-op deletes) do NOT count — only
 * member deletes can leave a runtime tombstone that the inline `struct.get`
 * read fast-path would bypass. Gates the tombstone-aware read routing so
 * delete-free modules emit byte-identical wasm.
 *
 * ---
 *
 * (#4187) `receiverNames` holds identifier names used as the RECEIVER of a
 * member delete anywhere in the program — `delete r.k` / `delete r[e]` yields
 * `r`.
 *
 * Consumed by `compilePropertyIntrospection` to decide whether a STANDALONE
 * `r.hasOwnProperty(k)` / `r.propertyIsEnumerable(k)` on a receiver that also
 * saw an `Object.defineProperty` may keep its compile-time constant fold. The
 * fold answers from the (defineProperty-widened) struct SHAPE, which no runtime
 * `delete` can retract, so it and the runtime state diverge for exactly the
 * receivers that appear here — and only for those. Receivers never deleted from
 * keep folding, so the overwhelming majority of modules stay byte-identical.
 *
 * Why a whole-program PRE-SCAN and not record-as-you-compile: in the canonical
 * repro the first read (`obj.hasOwnProperty("property")`, expected `true`)
 * precedes the `delete` TEXTUALLY. An order-sensitive record would route the
 * later read and fold the earlier one, so the two reads would answer from two
 * different mechanisms. The pre-scan routes BOTH to the runtime helper, which is
 * correct for both — it reports `true` before the delete and `false` after.
 *
 * Deliberately RECEIVER-scoped rather than receiver+key: `delete r[k]` with a
 * computed key can remove any property of `r`, so a key-level gate would have to
 * treat a computed delete as covering every key anyway. Bare `delete r` (a
 * no-op delete of a binding) does NOT count — it removes no property.
 *
 * Deliberately NOT alias-aware: `var a = r; delete a.k` records `a`, not `r`.
 * That is the safe direction — a missed name simply keeps today's fold, which is
 * exactly main's behaviour, whereas a spurious name would cost a runtime call on
 * a receiver that never needed one.
 */
export function scanModuleMemberDeletes(
  sourceFile: ts.SourceFile,
  collectReceivers: boolean,
): { any: boolean; receiverNames: Set<string> } {
  return scanMemberDeletes(sourceFile, collectReceivers);
}

/**
 * Names that a simple sloppy assignment may create as configurable properties
 * of the global object. The pre-scan makes read lowering independent of
 * function/body compilation order (#2726).
 */
export function collectSloppyImplicitGlobalNames(
  sourceFile: ts.SourceFile,
  oracle: TypeOracle,
  inferModuleStrict: boolean,
): Set<string> {
  const names = new Set<string>();
  function walk(node: ts.Node): void {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      let lhs = node.left;
      while (
        ts.isParenthesizedExpression(lhs) ||
        ts.isAsExpression(lhs) ||
        ts.isNonNullExpression(lhs) ||
        ts.isTypeAssertionExpression(lhs)
      ) {
        lhs = lhs.expression;
      }
      if (ts.isIdentifier(lhs) && !isStrictContext(lhs, inferModuleStrict) && oracle.isUnresolvableIdentifier(lhs)) {
        names.add(lhs.text);
      }
    }
    forEachChild(node, walk);
  }
  walk(sourceFile);
  return names;
}

export function recordSloppyImplicitGlobalNames(
  target: Set<string>,
  sourceFile: ts.SourceFile,
  oracle: TypeOracle,
  inferModuleStrict: boolean,
): void {
  for (const name of collectSloppyImplicitGlobalNames(sourceFile, oracle, inferModuleStrict)) target.add(name);
}

/**
 * (#3956) Property names a TOP-LEVEL write through the global object creates as
 * global-object properties — `this.p1 = 1` / `globalThis.p1 = 1` in script code.
 *
 * These are the OTHER way to create a global binding, and per §9.1.1.4.1
 * HasBinding on the global environment record they are just as resolvable by a
 * bare identifier as the `p1 = 1` form {@link collectSloppyImplicitGlobalNames}
 * already covers. Without them, a bare `p1` read after `this.p1 = 1` resolved to
 * nothing and fell through to codegen's auto-allocated-local fallback, silently
 * reading `0`/`undefined` instead of the value that was written.
 *
 * Deliberately narrow, because a false positive here turns a currently-silent
 * wrong answer into a thrown `ReferenceError`:
 *   - TOP-LEVEL CODE only — a `this.x = …` inside a function is a write to that
 *     function's receiver, not to the global object. "Top-level code" is the
 *     §9.4.2 sense used by {@link thisBelongsToTopLevelCode} and the #3365
 *     `ThisKeyword` lowering: the walk descends through `if` / loops / `try` /
 *     blocks and stops at a function or class boundary. (#4205 — the original
 *     #3956 cut looked only at DIRECT SourceFile ExpressionStatements, so
 *     `if (c) { this.r = 2; }` performed the write but never registered the
 *     name, and the bare `r` read fell back to the silent `0`.)
 *   - Root must be `this`, a non-shadowed `globalThis`, or a top-level ALIAS of
 *     one of those (`var g = this; g.q = 7` — the ES5 `fnGlobalObject()` idiom;
 *     any top-level reassignment of the alias name disqualifies it), reached
 *     only through parens / casts, with exactly one member step (`this.p1`,
 *     `this["p1"]`); a deeper chain like `this.o.k` writes into `o`, not the
 *     global object.
 *
 *     A reassignment INSIDE a function body does not disqualify — deliberately,
 *     because ruling it out costs a whole-file traversal (#3437) and buys
 *     nothing observable: if such a reassignment ran, the write landed on some
 *     other object, the global object has no such property, and the bare read
 *     throws the `ReferenceError` the spec asks for anyway.
 *   - Static property names only (identifier or string literal); a computed key
 *     is not knowable here.
 *   - No strict-mode gate: unlike an unresolvable bare assignment, a write
 *     through the global object is legal and creates the property in strict
 *     code too.
 *
 * The read path consults this set only AFTER locals, captures, module globals
 * and functions have all missed, so a name that also has a real binding can
 * never be diverted here.
 */
export function collectGlobalObjectPropertyNames(
  sourceFile: ts.SourceFile,
  moduleGlobals: ReadonlySet<string>,
): Set<string> {
  const names = new Set<string>();
  // (#4205 / #3437) Cheap total precondition. Every receiver this scan can
  // accept is spelled `this`, `globalThis`, or an alias initialised from one of
  // those — so if NEITHER token occurs in the source, no walk can find anything
  // and the scan is skippable outright. Same idiom as
  // `sourceUsesRuntimeEvalBoundary`; sound because it only skips on definite
  // absence. Both spellings are required: `globalThis` contains `This`, not
  // `this`, so a single lowercase test silently dropped every `globalThis`-only
  // file (caught by the alias case in tests/issue-4205-*).
  const text = sourceFile.text;
  if (!text.includes("this") && !text.includes("globalThis")) return names;

  // ONE walk collects both halves — the alias candidates and the pending
  // assignment targets — because a target's receiver can only be classified
  // once the alias set is known, and a second traversal is pure cost (#3437).
  const aliasCandidates = new Set<string>();
  const aliasDisqualified = new Set<string>();
  const pendingTargets: ts.Expression[] = [];
  const isGlobalObjectValue = (e: ts.Expression | undefined): boolean => {
    if (!e) return false;
    const cur = unwrapAssignmentTarget(e);
    if (cur.kind === ts.SyntaxKind.ThisKeyword) return true;
    return ts.isIdentifier(cur) && cur.text === "globalThis" && !moduleGlobals.has("globalThis");
  };

  walkTopLevelCode(sourceFile, (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      if (isGlobalObjectValue(node.initializer)) aliasCandidates.add(node.name.text);
      else aliasDisqualified.add(node.name.text);
      return;
    }
    if (!ts.isBinaryExpression(node)) return;
    const op = node.operatorToken.kind;
    if (op < ts.SyntaxKind.FirstAssignment || op > ts.SyntaxKind.LastAssignment) return;
    if (op === ts.SyntaxKind.EqualsToken) pendingTargets.push(node.left);
    // `g = somethingElse` re-points an alias, so a later `g.q = 7` is not
    // provably a write through the global object.
    if (ts.isIdentifier(node.left)) aliasDisqualified.add(node.left.text);
  });
  for (const name of aliasDisqualified) aliasCandidates.delete(name);

  const isGlobalObjectReceiver = (e: ts.Expression): boolean => {
    const cur = unwrapAssignmentTarget(e);
    if (cur.kind === ts.SyntaxKind.ThisKeyword) return true;
    if (!ts.isIdentifier(cur)) return false;
    if (cur.text === "globalThis") return !moduleGlobals.has("globalThis");
    return aliasCandidates.has(cur.text);
  };
  for (const target of pendingTargets) {
    const lhs = unwrapAssignmentTarget(target);
    if (ts.isPropertyAccessExpression(lhs)) {
      if (!isGlobalObjectReceiver(lhs.expression)) continue;
      if (ts.isPrivateIdentifier(lhs.name)) continue;
      names.add(lhs.name.text);
    } else if (ts.isElementAccessExpression(lhs)) {
      if (!isGlobalObjectReceiver(lhs.expression)) continue;
      const key = unwrapAssignmentTarget(lhs.argumentExpression);
      if (ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key)) names.add(key.text);
    }
  }
  return names;
}

/** Strip parens / casts / non-null assertions from an assignment target. */
function unwrapAssignmentTarget(e: ts.Expression): ts.Expression {
  let cur = e;
  while (
    ts.isParenthesizedExpression(cur) ||
    ts.isAsExpression(cur) ||
    ts.isNonNullExpression(cur) ||
    ts.isTypeAssertionExpression(cur)
  ) {
    cur = cur.expression;
  }
  return cur;
}

/**
 * Does the traversal descend THROUGH this node?
 *
 * (#3437) This is a compile-WORK decision as much as a correctness one. The
 * budget gate meters shared-helper `forEachChild` invocations against a
 * harness-shaped fixture, and a walk that descends into every expression pays
 * one invocation per AST node — which is how the first cut of #4205 added
 * +21,263 (+21.7 %) on a corpus where the harness prelude is prepended to all
 * ~43k tests. Statement CONTAINERS are the only nodes that can hold another
 * top-level statement, so descending through exactly those makes the walk
 * O(statements) instead of O(nodes).
 *
 * The three expression forms at the end are the only ones that can still hold a
 * top-level assignment this scan must see: an `ExpressionStatement`'s
 * expression, a parenthesised one, and the arms of a comma sequence.
 *
 * Deliberately NOT descended, and therefore deliberately missed: an assignment
 * buried in another expression position — `f(this.x = 1)`, `if (this.x = 1)`,
 * `[this.x = 1]`. Those perform the write but register no name, which is the
 * SAFE side of the invariant on {@link walkTopLevelCode}: a missing name reads
 * exactly as it does on main, whereas a spurious one throws a `ReferenceError`
 * that should not happen.
 */
function descendsThrough(node: ts.Node): boolean {
  if (ts.isSourceFile(node) || ts.isBlock(node)) return true;
  switch (node.kind) {
    case ts.SyntaxKind.IfStatement:
    case ts.SyntaxKind.ForStatement:
    case ts.SyntaxKind.ForInStatement:
    case ts.SyntaxKind.ForOfStatement:
    case ts.SyntaxKind.WhileStatement:
    case ts.SyntaxKind.DoStatement:
    case ts.SyntaxKind.TryStatement:
    case ts.SyntaxKind.CatchClause:
    case ts.SyntaxKind.SwitchStatement:
    case ts.SyntaxKind.CaseBlock:
    case ts.SyntaxKind.CaseClause:
    case ts.SyntaxKind.DefaultClause:
    case ts.SyntaxKind.LabeledStatement:
    case ts.SyntaxKind.WithStatement:
    case ts.SyntaxKind.VariableStatement:
    case ts.SyntaxKind.VariableDeclarationList:
    case ts.SyntaxKind.ExpressionStatement:
    case ts.SyntaxKind.ParenthesizedExpression:
      return true;
    case ts.SyntaxKind.BinaryExpression:
      return (node as ts.BinaryExpression).operatorToken.kind === ts.SyntaxKind.CommaToken;
    default:
      return false;
  }
}

/**
 * Visit the source file's TOP-LEVEL CODE — the §9.4.2 region in which `this` is
 * the realm global object. Descends through statement containers (see
 * {@link descendsThrough}) and never enters a function or class body, matching
 * {@link thisBelongsToTopLevelCode} (`sloppy-this-global.ts`), which is what the
 * `ThisKeyword` lowering itself consults. Keeping the two in step is the point:
 * a scan narrower than the lowering registers no name for a write that really
 * happens (#4205), and one wider registers a name for a receiver that is not
 * the global object. Where they must differ, this one stays NARROWER.
 */
function walkTopLevelCode(sourceFile: ts.SourceFile, visit: (node: ts.Node) => void): void {
  const walk = (node: ts.Node): void => {
    if (node !== sourceFile && (ts.isFunctionLike(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node))) {
      return;
    }
    visit(node);
    if (descendsThrough(node)) forEachChild(node, walk);
  };
  walk(sourceFile);
}

/** Script `var` binding names, including declarations nested in top-level control flow. */
export function recordScriptVarBindingNames(target: Set<string>, sourceFile: ts.SourceFile): void {
  const recordName = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) {
      target.add(name.text);
      return;
    }
    for (const element of name.elements) {
      if (!ts.isOmittedExpression(element)) recordName(element.name);
    }
  };
  const walk = (node: ts.Node): void => {
    if (node !== sourceFile && (ts.isFunctionLike(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node))) {
      return;
    }
    if (ts.isVariableDeclarationList(node) && (node.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) === 0) {
      for (const declaration of node.declarations) recordName(declaration.name);
    }
    forEachChild(node, walk);
  };
  walk(sourceFile);
}

/** Per-file memo for {@link scriptVarBindingNames}. */
const scriptVarBindingNameCache = new WeakMap<ts.SourceFile, ReadonlySet<string>>();

/**
 * (#4489) Memoized set form of {@link recordScriptVarBindingNames}, for callers
 * that need the names rather than a set to accumulate into.
 *
 * The `__module_init` `undefined` seed asks for this once per module-init pass
 * (the body is compiled twice, #2965) and the walk is over the whole top-level
 * region, so it is memoized per source file. Ambient files answer the empty set:
 * `collectDeclarations` never gives an ambient declaration a value global, so
 * there is nothing to seed and a name collected from one would be a phantom
 * (the #4018 hazard on the TDZ side).
 */
export function scriptVarBindingNames(sourceFile: ts.SourceFile): ReadonlySet<string> {
  const cached = scriptVarBindingNameCache.get(sourceFile);
  if (cached !== undefined) return cached;
  const names = new Set<string>();
  if (!sourceFile.isDeclarationFile) recordScriptVarBindingNames(names, sourceFile);
  scriptVarBindingNameCache.set(sourceFile, names);
  return names;
}

/** Names owned by the declarative half of a Script's GlobalEnvironmentRecord.
 * Only declarations that are direct SourceFile children participate: a
 * block/loop lexical has its own nested environment and must not collide with
 * a later indirect-eval `var` declaration. */
export function recordScriptGlobalLexicalBindingNames(target: Set<string>, sourceFile: ts.SourceFile): void {
  const recordName = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) {
      target.add(name.text);
      return;
    }
    for (const element of name.elements) {
      if (!ts.isOmittedExpression(element)) recordName(element.name);
    }
  };
  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement)) {
      if ((statement.declarationList.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) === 0) continue;
      for (const declaration of statement.declarationList.declarations) recordName(declaration.name);
    } else if (ts.isClassDeclaration(statement) && statement.name) {
      target.add(statement.name.text);
    }
  }
}

/**
 * (#3057) True when the source dynamically constructs a `$__ta_dyn_view` —
 * `new <ctorExpr>(bufferArg[, off[, len]])` where `<ctorExpr>` is an IDENTIFIER
 * that is NOT a statically-named TA constructor (so it's a TA constructor held in
 * a variable / array element, type `any` or a TA-ctor union — test262
 * `for (ctor of ctors) new ctor(rab, …)` / `CreateRabForTest`) and NOT a user
 * class. Mirrors the runtime dynamic-construct gate in `new-super.ts` (buffer-typed
 * first arg, non-numeric-literal). Used to enable the runtime-kind element byte
 * codec on the generic index path for helper functions compiled BEFORE the
 * construct (the `$__ta_dyn_view` type registers lazily). Byte-inert: modules
 * without this pattern never set the flag, so they never emit the codec arm.
 */
export function sourceHasDynamicTaConstruct(checker: ts.TypeChecker, sourceFile: ts.SourceFile): boolean {
  // (#3272) Reuse the module-level TYPED_ARRAY_NAMES set — identical 9 names.
  const TA_NAMES = TYPED_ARRAY_NAMES;
  let found = false;
  function walk(node: ts.Node): void {
    if (found) return;
    if (ts.isNewExpression(node)) {
      let callee: ts.Expression = node.expression;
      while (ts.isParenthesizedExpression(callee) || ts.isAsExpression(callee) || ts.isNonNullExpression(callee)) {
        callee = callee.expression;
      }
      if (ts.isIdentifier(callee)) {
        // Static TA name (`new Uint8Array(buf)`) is handled by the static view
        // ctor path, never the dynamic one — skip it.
        if (!TA_NAMES.has(callee.text)) {
          // A user class callee resolves to a ClassDeclaration value — skip; only
          // a value-bound ctor (variable / param / any) reaches the dynamic path.
          const sym = checker.getSymbolAtLocation(callee);
          const decl = sym?.valueDeclaration;
          const isUserClass = decl !== undefined && ts.isClassDeclaration(decl);
          if (!isUserClass) {
            const arg0 = node.arguments && node.arguments.length >= 1 ? node.arguments[0]! : undefined;
            // Buffer-typed first arg gates the dynamic TA construct (the #3054 D
            // buffer form) — excludes `new fn(x)` on unrelated identifiers.
            if (arg0 !== undefined && !ts.isNumericLiteral(arg0)) {
              let arg0Sym: string | undefined;
              try {
                arg0Sym = checker.getTypeAtLocation(arg0).getSymbol?.()?.name;
              } catch {
                arg0Sym = undefined;
              }
              if (arg0Sym === "ArrayBuffer" || arg0Sym === "SharedArrayBuffer" || arg0Sym === "DataView") {
                found = true;
                return;
              }
            }
            // (#2872) General dynamic-ctor forms — `new TA(3)`, `new TA([…])`,
            // `new TA(otherTA)`, `new TA()` on a GENUINELY-dynamic callee (an
            // `any`/`unknown`-typed param / variable / binding element declared
            // in real source — the `testWithTypedArrayConstructors(TA => …)`
            // harness shape). Mirrors `resolvesToDynamicAnyCtorValue`
            // (new-super.ts): declaration-file symbols (ambient globals) and
            // typed function/class bindings never set the flag, so ordinary
            // `new F(...)` function-ctor modules stay byte-identical.
            if (
              decl !== undefined &&
              !decl.getSourceFile().isDeclarationFile &&
              (ts.isParameter(decl) || ts.isVariableDeclaration(decl) || ts.isBindingElement(decl))
            ) {
              try {
                const calleeType = checker.getTypeAtLocation(callee);
                if ((calleeType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) {
                  found = true;
                  return;
                }
              } catch {
                /* type resolution failure — leave the flag unset */
              }
            }
          }
        }
      }
    }
    forEachChild(node, walk);
  }
  walk(sourceFile);
  return found;
}

/**
 * #1623 — true when the source contains any object/array binding pattern
 * (destructuring) in a parameter, variable declaration, or assignment target.
 * Used to decide whether to pre-emit the WASI/standalone TypeError constructor
 * before user functions compile, so the destructuring null-throw guard's
 * `emitWasiErrorConstructor` call doesn't run mid-prologue and clobber a
 * reserved user-function slot.
 */
export function sourceContainsBindingPattern(sourceFile: ts.SourceFile): boolean {
  let found = false;
  function walk(node: ts.Node): void {
    if (found) return;
    if (ts.isObjectBindingPattern(node) || ts.isArrayBindingPattern(node)) {
      found = true;
      return;
    }
    forEachChild(node, walk);
  }
  walk(sourceFile);
  return found;
}

/**
 * (#1719 S1) Whole-program pre-scan for the `ITER_OVERRIDDEN` brand of the
 * array object-value representation track. Returns true iff the source may
 * monkeypatch `Array.prototype`'s iterator surface, i.e. it contains:
 *   (i)  an assignment `Array.prototype[Symbol.iterator] = …` or
 *        `Array.prototype.values = …` (any element/property access whose
 *        object is `Array.prototype`), OR
 *   (ii) `Object.defineProperty(Array.prototype, …)` /
 *        `Object.defineProperties(Array.prototype, …)`.
 *
 * When this returns false (the overwhelming common case), the array
 * destructuring / spread / for-of fast paths are provably unaffected by any
 * prototype override and stay byte-identical (see `arrayDstrNeedsIdentity`).
 * When true, the S2 slice routes a branded array RHS through the host-Array
 * reflection + host `GetIterator` so the override's `@@iterator` is observed
 * (§7.4.2 GetIterator, §8.5.2 IteratorBindingInitialization).
 *
 * Reused verbatim from the dev-a `issue-1719-impl` scaffolding (the front-end
 * half the architecture spec endorses keeping). Conservative by design: it
 * over-approximates (a false positive only costs the S2 slow path, never
 * correctness) and never under-approximates a literal `Array.prototype` LHS.
 */
export function sourceOverridesArrayIterator(sourceFile: ts.SourceFile): boolean {
  let found = false;
  // Strip `as`/`!`/type-assertion/paren wrappers so `(Array.prototype as any)[…]`
  // and `(Array.prototype)[…]` match the same as the bare form.
  function unwrap(e: ts.Expression): ts.Expression {
    let cur = e;
    while (
      ts.isParenthesizedExpression(cur) ||
      ts.isAsExpression(cur) ||
      ts.isNonNullExpression(cur) ||
      ts.isTypeAssertionExpression(cur)
    ) {
      cur = ts.isParenthesizedExpression(cur)
        ? cur.expression
        : ts.isAsExpression(cur)
          ? cur.expression
          : ts.isNonNullExpression(cur)
            ? cur.expression
            : (cur as ts.TypeAssertion).expression;
    }
    return cur;
  }
  // `e` is the object being assigned INTO: match `Array.prototype[...]`
  // (element access) or `Array.prototype.values` (property access).
  function isArrayProtoLHS(e: ts.Expression): boolean {
    if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) {
      const obj = unwrap(e.expression);
      return (
        ts.isPropertyAccessExpression(obj) &&
        obj.name.text === "prototype" &&
        ts.isIdentifier(obj.expression) &&
        obj.expression.text === "Array"
      );
    }
    return false;
  }
  function walk(node: ts.Node): void {
    if (found) return;
    // (i) assignment: Array.prototype[Symbol.iterator] = … / Array.prototype.values = …
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      isArrayProtoLHS(node.left)
    ) {
      found = true;
      return;
    }
    // (ii) Object.defineProperty(Array.prototype, …) / Object.defineProperties(Array.prototype, …)
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const callee = node.expression;
      const arg0 = node.arguments[0];
      if (
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === "Object" &&
        (callee.name.text === "defineProperty" || callee.name.text === "defineProperties") &&
        arg0 !== undefined &&
        ts.isPropertyAccessExpression(arg0) &&
        arg0.name.text === "prototype" &&
        ts.isIdentifier(arg0.expression) &&
        arg0.expression.text === "Array"
      ) {
        found = true;
        return;
      }
    }
    forEachChild(node, walk);
  }
  walk(sourceFile);
  return found;
}
