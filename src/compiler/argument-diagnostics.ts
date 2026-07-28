/**
 * Classification of TS2345 ("Argument of type 'X' is not assignable to
 * parameter of type 'Y'") diagnostics that are TypeScript fictions rather than
 * real runtime type errors.
 *
 * TS2345 is a HARD diagnostic in `src/compiler.ts` — one occurrence aborts the
 * compile before codegen runs. That is correct when the author stated a type
 * and the call site violates it, but wrong when the "declared" type was only
 * inferred by TypeScript from a shape that carries no runtime meaning. The
 * predicates here identify those inferred-type cases.
 */
import ts from "typescript";

/**
 * Find the smallest node in `file` containing `pos`.
 */
export function findSmallestNodeAtPosition(file: ts.SourceFile, pos: number): ts.Node | undefined {
  function visit(node: ts.Node): ts.Node | undefined {
    if (pos < node.getStart(file) || pos >= node.getEnd()) return undefined;
    let found: ts.Node = node;
    node.forEachChild((child) => {
      const inner = visit(child);
      if (inner) found = inner;
    });
    return found;
  }
  return visit(file);
}

/**
 * Resolve the parameter an argument-assignability diagnostic (TS2345) is
 * complaining about: locate the argument node at `diag.start`, walk up to its
 * enclosing call/new expression, resolve the signature, and return the
 * parameter in that position.
 *
 * Returns undefined when any step fails, or when the parameter carries an
 * explicit type annotation — an annotation is the author's stated intent, so a
 * mismatch against it is never a false positive.
 */
function resolveUnannotatedArgumentParameter(
  diag: ts.Diagnostic,
  checker: ts.TypeChecker,
): ts.ParameterDeclaration | undefined {
  const file = diag.file;
  if (!file || diag.start === undefined) return undefined;
  const pos = diag.start;
  let n: ts.Node | undefined = findSmallestNodeAtPosition(file, pos);
  while (n && !ts.isCallExpression(n) && !ts.isNewExpression(n)) {
    n = n.parent;
  }
  if (!n || !(ts.isCallExpression(n) || ts.isNewExpression(n))) return undefined;
  const args = n.arguments;
  if (!args) return undefined;
  let argIdx = -1;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (pos >= a.getStart(file) && pos < a.getEnd()) {
      argIdx = i;
      break;
    }
  }
  if (argIdx < 0) return undefined;
  const paramDecl = checker.getResolvedSignature(n)?.getDeclaration()?.parameters?.[argIdx];
  if (!paramDecl || paramDecl.type) return undefined; // explicit annotation — respect it
  return paramDecl;
}

/**
 * #862: TypeScript infers `function f([,])` as `function f([,]: [any?])` — a tuple type.
 * A call site like `f(generator)` then trips TS2345 even though, in JS/TS at runtime,
 * a binding-pattern parameter destructures any iterable per ECMA-262 §13.3.3.6
 * (IteratorBindingInitialization). Suppress 2345 when the target parameter uses an
 * array/object binding pattern and lacks an explicit type annotation — the inferred
 * tuple type is a TypeScript fiction that does not reflect runtime semantics.
 */
export function isBindingPatternFalsePositive(diag: ts.Diagnostic, checker: ts.TypeChecker): boolean {
  if (diag.code !== 2345) return false;
  const paramDecl = resolveUnannotatedArgumentParameter(diag, checker);
  if (!paramDecl) return false;
  return ts.isArrayBindingPattern(paramDecl.name) || ts.isObjectBindingPattern(paramDecl.name);
}

/** `.js` / `.mjs` / `.cjs` / `.jsx` — a file with no TypeScript annotations available. */
const JS_SOURCE_FILE_RE = /\.[cm]?jsx?$/i;

/**
 * TypeScript infers an unannotated JS parameter's type from its default-value
 * initializer: `function f(prerelease = "")` becomes `prerelease: string`. A
 * call site passing anything wider then trips TS2345 even though the body may
 * handle the wider type explicitly — TypeScript's own shipped bundle does
 * exactly this in `semver.ts`:
 *
 * ```js
 * constructor(major, minor = 0, patch = 0, prerelease = "", build = "") {
 *   const prereleaseArray = prerelease ? isArray(prerelease) ? prerelease : prerelease.split(".") : emptyArray;
 * ```
 *
 * …called as `new Version(0, 0, 0, ["0"])`. The original `.ts` source declares
 * `prerelease?: string | readonly string[]`, but that annotation is erased in
 * the published JS, so the checker sees only the `""` default.
 *
 * In a JS file the inferred type is a TypeScript fiction with no runtime
 * meaning, so it must not gate codegen. Scoped to JS source files and to
 * parameters that have an initializer, no explicit annotation, and no JSDoc
 * type tag (JSDoc is the JS author's stated intent — respect it, same as an
 * annotation).
 */
export function isJsDefaultInferredParamFalsePositive(diag: ts.Diagnostic, checker: ts.TypeChecker): boolean {
  if (diag.code !== 2345) return false;
  if (!diag.file || !JS_SOURCE_FILE_RE.test(diag.file.fileName)) return false;
  const paramDecl = resolveUnannotatedArgumentParameter(diag, checker);
  if (!paramDecl?.initializer) return false;
  return !ts.getJSDocParameterTags(paramDecl).some((tag) => tag.typeExpression !== undefined);
}
