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
 * (#2179) True when the source contains a `delete` operating on a property or
 * element access (`delete o.a` / `delete o[k]`). `delete x` of a bare
 * identifier and `delete <other expr>` (no-op deletes) do NOT count — only
 * member deletes can leave a runtime tombstone that the inline struct.get
 * read fast-path would bypass. Used to gate the tombstone-aware read routing
 * so delete-free modules emit byte-identical wasm.
 */
export function sourceContainsDelete(sourceFile: ts.SourceFile): boolean {
  let found = false;
  function walk(node: ts.Node): void {
    if (found) return;
    if (
      ts.isDeleteExpression(node) &&
      (ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression))
    ) {
      found = true;
      return;
    }
    forEachChild(node, walk);
  }
  walk(sourceFile);
  return found;
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
 *   - Root must be `this`, a non-shadowed `globalThis`, or a top-level alias
 *     of one of those ({@link collectGlobalObjectAliasNames}), reached only
 *     through parens / casts, with exactly one member step (`this.p1`,
 *     `this["p1"]`); a deeper chain like `this.o.k` writes into `o`, not the
 *     global object.
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
  const aliases = collectGlobalObjectAliasNames(sourceFile, moduleGlobals);
  const isGlobalObjectReceiver = (e: ts.Expression): boolean => {
    const cur = unwrapAssignmentTarget(e);
    if (cur.kind === ts.SyntaxKind.ThisKeyword) return true;
    if (!ts.isIdentifier(cur)) return false;
    if (cur.text === "globalThis") return !moduleGlobals.has("globalThis");
    return aliases.has(cur.text);
  };
  const recordTarget = (target: ts.Expression): void => {
    const lhs = unwrapAssignmentTarget(target);
    if (ts.isPropertyAccessExpression(lhs)) {
      if (!isGlobalObjectReceiver(lhs.expression)) return;
      if (ts.isPrivateIdentifier(lhs.name)) return;
      names.add(lhs.name.text);
    } else if (ts.isElementAccessExpression(lhs)) {
      if (!isGlobalObjectReceiver(lhs.expression)) return;
      const key = unwrapAssignmentTarget(lhs.argumentExpression);
      if (ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key)) names.add(key.text);
    }
  };
  walkTopLevelCode(sourceFile, (node) => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      recordTarget(node.left);
    }
  });
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
 * Visit every node of the source file's TOP-LEVEL CODE — the §9.4.2 region in
 * which `this` is the realm global object. Descends through statements and
 * expressions but never enters a function or class body, matching
 * {@link thisBelongsToTopLevelCode} (`sloppy-this-global.ts`), which is what the
 * `ThisKeyword` lowering itself consults. Keeping the two in step is the point:
 * a scan narrower than the lowering registers no name for a write that really
 * happens (#4205), and one wider registers a name for a receiver that is not
 * the global object.
 */
function walkTopLevelCode(sourceFile: ts.SourceFile, visit: (node: ts.Node) => void): void {
  const walk = (node: ts.Node): void => {
    if (node !== sourceFile && (ts.isFunctionLike(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node))) {
      return;
    }
    visit(node);
    forEachChild(node, walk);
  };
  walk(sourceFile);
}

/**
 * (#4205) Top-level `var g = this;` / `var g = globalThis;` alias names.
 *
 * `var g = this; g.q = 7;` creates the global-object property `q` exactly as
 * `this.q = 7` does — the ES5 `fnGlobalObject()`-style idiom test262 uses
 * throughout. The write already lands on the right object (the checker types
 * the alias as `typeof globalThis`); only the NAME registration was missing,
 * so the bare `q` read fell back to the silent `0`.
 *
 * Conservative by construction — an alias qualifies only when:
 *   - it is declared in top-level code (never inside a function/class), and
 *   - EVERY declaration of that name in the file initialises it to `this` /
 *     `globalThis` (so a later `var g = somethingElse` disqualifies it), and
 *   - the name is never the target of an assignment or an update operator
 *     anywhere in the file (including inside functions).
 *
 * A name that fails any of these keeps today's behaviour exactly.
 */
export function collectGlobalObjectAliasNames(
  sourceFile: ts.SourceFile,
  moduleGlobals: ReadonlySet<string>,
): ReadonlySet<string> {
  const candidates = new Set<string>();
  const disqualified = new Set<string>();
  const isGlobalObjectValue = (e: ts.Expression | undefined): boolean => {
    if (!e) return false;
    const cur = unwrapAssignmentTarget(e);
    if (cur.kind === ts.SyntaxKind.ThisKeyword) return true;
    return ts.isIdentifier(cur) && cur.text === "globalThis" && !moduleGlobals.has("globalThis");
  };
  walkTopLevelCode(sourceFile, (node) => {
    if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name)) return;
    if (isGlobalObjectValue(node.initializer)) candidates.add(node.name.text);
    else disqualified.add(node.name.text);
  });
  if (candidates.size === 0) return candidates;
  // A reassignment anywhere — including inside a function body — breaks the
  // alias, so this second walk deliberately covers the WHOLE file.
  const disqualifyWrites = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      ts.isIdentifier(node.left)
    ) {
      disqualified.add(node.left.text);
    }
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && ts.isIdentifier(node.operand)) {
      disqualified.add(node.operand.text);
    }
    // A second declaration of the same name with a non-global initializer.
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && !isGlobalObjectValue(node.initializer)) {
      disqualified.add(node.name.text);
    }
    forEachChild(node, disqualifyWrites);
  };
  forEachChild(sourceFile, disqualifyWrites);
  for (const name of disqualified) candidates.delete(name);
  return candidates;
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
