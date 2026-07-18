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
