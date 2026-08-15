// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4428) Module-global element-representation widening for a `var` that is
 * REBOUND to arrays whose elements live in different JS domains.
 *
 * ## The defect
 *
 * `moduleGlobalWasmType` pins an array binding's vec type from the checker type
 * of its FIRST declaration. For a `.js` source TypeScript never revisits that:
 * a redeclared `var` keeps declaration #1's type even when declaration #2
 * initializes it with something else entirely.
 *
 * ```js
 * var x = new Array(true);          // checker: boolean[]  → (mut $__vec_i32)
 * var obj = new Boolean(false);
 * var x = new Array(obj);           // builds a $__vec_externref …
 * x[0] === obj;                     // … which is then CONVERTED into the i32 vec
 * ```
 *
 * The second store is a vec→vec coercion (`emitSafeStructConversion`,
 * type-coercion.ts), which copies element-by-element through `ToNumber`. The
 * Boolean wrapper arrives as the i32 `0` and its object identity is gone —
 * test262 `S15.4.2.2_A2.3_T2` / `_T3` fail on `x[0] === obj` while `_T4` /
 * `_T5` (Number wrapper, no primitive-array predecessor) pass. Nothing is
 * wrong with the wrapper constructors or with #4426's one-element
 * `new Array(<non-number>)` path: both were verified to preserve identity in
 * isolation. The loss is entirely in the coercion the too-narrow slot forces.
 *
 * ## Why widening the ELEMENT type, not the carrier
 *
 * The existing dynamic-carrier widenings (#4204 here, `bindingHasMixedAssignmentCarrier`
 * for locals) answer `externref` — the whole array becomes a boxed value. That
 * does preserve `x[0]`'s identity, but a boxed vec loses `.length` (measured:
 * `x.length === 1` reads `0`), so it trades one failing assertion for another.
 * Keeping the slot a vec and widening only its ELEMENT type to `externref`
 * keeps the length field on the static path and makes the second store a
 * no-op coercion.
 *
 * ## Why the predicate is deliberately narrow
 *
 * Widening an element type is a representation change on every read of the
 * array, so this fires only on a PROVED disagreement between two SEPARATE
 * writes: one that stores an array of objects, another that stores an array of
 * primitives. Both must be syntactically classifiable (array literal, or an
 * `Array(...)` / `new Array(...)` in its element form) with non-`mixed` tags
 * for every element — a single unclassifiable write to the binding abandons the
 * analysis for that binding entirely, leaving today's type in place. Mixing
 * WITHIN one write (`[obj, true]`) is the array-literal element-typing lane's
 * job and is not touched here.
 */
import type { JsTag } from "../../checker/oracle.js";
import type { ValType } from "../../ir/types.js";
import { ts } from "../../ts-api.js";
import type { CodegenContext } from "../context/types.js";
import { getOrRegisterVecType } from "../registry/types.js";

/** Per-(context, file) memo — `moduleGlobalWasmType` asks once per declaration. */
const analysisCache = new WeakMap<CodegenContext, Map<ts.SourceFile, ReadonlySet<string>>>();

/** The domain a single whole-array write stores into the binding. */
type WriteDomain = "object" | "primitive";

/** Tags whose values are references with observable identity. */
const OBJECT_TAGS: ReadonlySet<JsTag> = new Set<JsTag>(["object", "function"]);

/**
 * The widened slot type for `decl`, or `undefined` to leave the type picker's
 * decision alone.
 */
export function rebindWidenedArrayVecType(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile,
  decl: ts.VariableDeclaration,
): ValType | undefined {
  if (!ts.isIdentifier(decl.name)) return undefined;
  if (!widenedVarsOf(ctx, sourceFile).has(decl.name.text)) return undefined;
  return { kind: "ref_null", typeIdx: getOrRegisterVecType(ctx, "externref", { kind: "externref" }) };
}

/**
 * Memoized analysis result for one file. Both entry points go through here:
 * `typeof` asks per OPERAND, so an uncached recompute would walk the whole file
 * once per `typeof x[i]` in it.
 */
function widenedVarsOf(ctx: CodegenContext, sourceFile: ts.SourceFile): ReadonlySet<string> {
  let perFile = analysisCache.get(ctx);
  if (perFile === undefined) {
    perFile = new Map();
    analysisCache.set(ctx, perFile);
  }
  let widened = perFile.get(sourceFile);
  if (widened === undefined) {
    widened = collectElementRebindWidenedVars(ctx, sourceFile);
    perFile.set(sourceFile, widened);
  }
  return widened;
}

/**
 * (#4428) Is `expr` an indexed read off a binding whose element representation
 * was widened here, while the checker still describes the element as a
 * primitive?
 *
 * A widened binding keeps its first declaration's checker type — `var x = new
 * Array(true)` stays `boolean[]` even after the slot's elements become
 * `externref`. Any consumer that CONST-FOLDS from that type is unsound on the
 * widened array, and `typeof` is the one that shows: it folds `typeof x[0]` to
 * the literal `"boolean"` and never reads the value, so a stored wrapper object
 * reports as a boolean. Folds that instead LOWER from the checker type are fine
 * — they go through the ordinary externref coercions and observe the real value
 * (`===`, `.length` and the indexed read itself are all verified).
 *
 * Mirrors {@link moduleGlobalIsDynamicButStaticallyPrimitive} (#4204), which
 * carries the identical disagreement one level up, at the binding itself.
 */
export function elementReadOfRebindWidenedArray(ctx: CodegenContext, expr: ts.Expression): boolean {
  if (!ts.isElementAccessExpression(expr) || !ts.isIdentifier(expr.expression)) return false;
  const base = expr.expression;
  const decl = ctx.oracle.variableDeclarationOf(base);
  if (decl === undefined || !ts.isIdentifier(decl.name) || !isModuleScoped(decl)) return false;
  return widenedVarsOf(ctx, decl.getSourceFile()).has(decl.name.text);
}

/** True when `node` is hoisted to module scope — i.e. no function-like ancestor. */
function isModuleScoped(node: ts.Node): boolean {
  for (let p = node.parent; p !== undefined && !ts.isSourceFile(p); p = p.parent) {
    if (
      ts.isFunctionDeclaration(p) ||
      ts.isFunctionExpression(p) ||
      ts.isArrowFunction(p) ||
      ts.isMethodDeclaration(p) ||
      ts.isGetAccessorDeclaration(p) ||
      ts.isSetAccessorDeclaration(p) ||
      ts.isConstructorDeclaration(p) ||
      ts.isClassDeclaration(p) ||
      ts.isClassExpression(p) ||
      ts.isModuleDeclaration(p)
    ) {
      return false;
    }
  }
  return true;
}

/**
 * The element tags a whole-array write stores, or `null` when the expression is
 * not a syntactically classifiable array construction.
 *
 * `undefined` means "an array with no statically known elements" (`[]`, or the
 * `new Array(len)` length form): carries no element evidence, and — unlike
 * `null` — does not abandon the binding.
 */
function writtenElementTags(ctx: CodegenContext, expr: ts.Expression): readonly JsTag[] | undefined | null {
  if (ts.isArrayLiteralExpression(expr)) {
    if (expr.elements.length === 0) return undefined;
    const tags: JsTag[] = [];
    for (const element of expr.elements) {
      if (ts.isSpreadElement(element) || ts.isOmittedExpression(element)) return null;
      const tag = ctx.oracle.staticJsTypeOf(element);
      if (tag === "mixed") return null;
      tags.push(tag);
    }
    return tags;
  }
  if (ts.isNewExpression(expr) || ts.isCallExpression(expr)) {
    const callee = expr.expression;
    if (!ts.isIdentifier(callee) || callee.text !== "Array") return null;
    const args = expr.arguments;
    if (args === undefined || args.length === 0) return undefined;
    const tags: JsTag[] = [];
    for (const argument of args) {
      if (ts.isSpreadElement(argument)) return null;
      const tag = ctx.oracle.staticJsTypeOf(argument);
      if (tag === "mixed") return null;
      tags.push(tag);
    }
    // §23.1.1.1 step 5 / ES5 §15.4.2.2: a SINGLE Number argument is a LENGTH,
    // so the array has no statically known elements. Every other single
    // argument, and every multi-argument form, is an element list (#4426).
    if (tags.length === 1 && tags[0] === "number") return undefined;
    return tags;
  }
  return null;
}

/** The domain of one write, or `undefined` when it carries no element evidence. */
function writeDomain(tags: readonly JsTag[] | undefined): WriteDomain | undefined {
  if (tags === undefined || tags.length === 0) return undefined;
  const objectElements = tags.filter((tag) => OBJECT_TAGS.has(tag)).length;
  if (objectElements === tags.length) return "object";
  if (objectElements === 0) return "primitive";
  // Mixed within a single write — the array-literal element-typing lane's job.
  return undefined;
}

/**
 * Names of module-scoped bindings written with BOTH an object-element array and
 * a primitive-element array, so no single non-`externref` element type can carry
 * every stored value.
 */
function collectElementRebindWidenedVars(ctx: CodegenContext, sourceFile: ts.SourceFile): ReadonlySet<string> {
  /** name → domains seen, or `null` once an unclassifiable write abandons it. */
  const seen = new Map<string, Set<WriteDomain> | null>();

  const record = (name: string, value: ts.Expression): void => {
    if (seen.get(name) === null) return;
    const tags = writtenElementTags(ctx, value);
    if (tags === null) {
      seen.set(name, null);
      return;
    }
    const domain = writeDomain(tags);
    if (domain === undefined) {
      if (!seen.has(name)) seen.set(name, new Set());
      return;
    }
    const domains = seen.get(name) ?? new Set<WriteDomain>();
    domains.add(domain);
    seen.set(name, domains);
  };

  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      isModuleScoped(node)
    ) {
      record(node.name.text, node.initializer);
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    ) {
      // Binding identity from the oracle, never the bare name (#3364): a
      // same-named function local must not widen a module global.
      const target = ctx.oracle.variableDeclarationOf(node.left);
      if (target !== undefined && target.getSourceFile() === sourceFile && isModuleScoped(target)) {
        record(node.left.text, node.right);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  const widened = new Set<string>();
  for (const [name, domains] of seen) {
    if (domains !== null && domains.has("object") && domains.has("primitive")) widened.add(name);
  }
  return widened;
}
