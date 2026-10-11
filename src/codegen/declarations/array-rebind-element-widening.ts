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
import { jsTagOfFact, type JsTag } from "../../checker/oracle.js";
import type { ValType } from "../../ir/types.js";
import { ts } from "../../ts-api.js";
import type { CodegenContext } from "../context/types.js";
import { getOrRegisterVecType } from "../registry/types.js";
import { descriptorArrayCarrierType } from "./descriptor-array-carrier.js";

/** Per-(context, file) memo — `moduleGlobalWasmType` asks once per declaration. */
const analysisCache = new WeakMap<CodegenContext, Map<ts.SourceFile, ReadonlySet<string>>>();

/** The domain a single whole-array write stores into the binding. */
type WriteDomain = "object" | "primitive";

/** `typeof null` is "object", but it is not an object-element carrier. */
type WriteTag = JsTag | "nullish";

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
  const descriptorCarrier = descriptorArrayCarrierType(ctx, decl);
  if (descriptorCarrier !== undefined) return descriptorCarrier;
  const descriptorType = descriptorValueWidenedArrayVecType(ctx, sourceFile, decl);
  if (descriptorType !== undefined) return descriptorType;
  if (!widenedVarsOf(ctx, sourceFile).has(decl.name.text)) return undefined;
  return { kind: "ref_null", typeIdx: getOrRegisterVecType(ctx, "externref", { kind: "externref" }) };
}

/**
 * (#4491) A standalone data descriptor can write a value whose JS tag cannot
 * live in the array's inferred primitive element carrier. The descriptor
 * overlay correctly keeps that value in its companion, but a typed element
 * read would otherwise bypass the companion and return the stale primitive
 * slot. Widen the binding's element carrier before its initializer is built so
 * the ordinary vec read/write path remains authoritative.
 *
 * This is deliberately limited to statically known indexed data descriptors:
 * unknown descriptors and non-index expandos retain their existing lowering,
 * while a dynamic value remains the overlay's responsibility. The standalone
 * lane is the only one with this WasmGC vec/companion split; host arrays do not
 * need a representation change here.
 */
export function descriptorValueWidenedArrayVecType(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile,
  decl: ts.VariableDeclaration,
): ValType | undefined {
  if (!ctx.standalone || !ts.isIdentifier(decl.name)) return undefined;
  const elementTag = jsTagOfFact(ctx.oracle.elementFactOf(decl));
  if (elementTag === undefined || !["number", "string", "boolean", "bigint"].includes(elementTag)) {
    return undefined;
  }

  let widened = false;
  const indexedKey = (node: ts.Node): boolean => {
    const key = ts.isStringLiteral(node) || ts.isNumericLiteral(node) ? node.text : undefined;
    if (key === undefined || !/^(0|[1-9][0-9]*)$/.test(key)) return false;
    const numeric = Number(key);
    return Number.isInteger(numeric) && numeric >= 0 && numeric < 0xffffffff;
  };
  const descriptorValue = (node: ts.Expression): ts.Expression | undefined => {
    let desc = node;
    while (
      ts.isParenthesizedExpression(desc) ||
      ts.isAsExpression(desc) ||
      ts.isTypeAssertionExpression(desc) ||
      ts.isNonNullExpression(desc) ||
      ts.isSatisfiesExpression(desc)
    ) {
      desc = desc.expression;
    }
    if (!ts.isObjectLiteralExpression(desc)) return undefined;
    let value: ts.Expression | undefined;
    for (const property of desc.properties) {
      if (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) {
        const name = property.name;
        if ((ts.isIdentifier(name) || ts.isStringLiteral(name)) && name.text === "value") {
          value = ts.isPropertyAssignment(property) ? property.initializer : property.name;
        }
      }
      if (
        (ts.isPropertyAssignment(property) || ts.isMethodDeclaration(property)) &&
        (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
        (property.name.text === "get" || property.name.text === "set")
      ) {
        return undefined;
      }
    }
    return value;
  };
  const incompatible = (value: ts.Expression): boolean => {
    const valueTag = ctx.oracle.staticJsTypeOf(value);
    return valueTag !== "mixed" && valueTag !== elementTag;
  };
  const visit = (node: ts.Node): void => {
    if (widened || !ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) {
      ts.forEachChild(node, visit);
      return;
    }
    const callee = node.expression;
    if (
      !ts.isIdentifier(callee.expression) ||
      callee.expression.text !== "Object" ||
      !ts.isIdentifier(callee.name) ||
      (callee.name.text !== "defineProperty" && callee.name.text !== "defineProperties")
    ) {
      ts.forEachChild(node, visit);
      return;
    }
    const receiver = node.arguments[0];
    if (!receiver || !ts.isIdentifier(receiver) || ctx.oracle.variableDeclarationOf(receiver) !== decl) {
      ts.forEachChild(node, visit);
      return;
    }
    if (callee.name.text === "defineProperty" && node.arguments.length >= 3) {
      const key = node.arguments[1]!;
      const value = descriptorValue(node.arguments[2]!);
      if (indexedKey(key) && value !== undefined && incompatible(value)) widened = true;
    } else if (callee.name.text === "defineProperties" && node.arguments.length >= 2) {
      let descriptors = node.arguments[1]!;
      while (
        ts.isParenthesizedExpression(descriptors) ||
        ts.isAsExpression(descriptors) ||
        ts.isTypeAssertionExpression(descriptors) ||
        ts.isNonNullExpression(descriptors) ||
        ts.isSatisfiesExpression(descriptors)
      ) {
        descriptors = descriptors.expression;
      }
      if (ts.isObjectLiteralExpression(descriptors)) {
        for (const property of descriptors.properties) {
          if (!ts.isPropertyAssignment(property)) continue;
          const value = descriptorValue(property.initializer);
          if (indexedKey(property.name) && value !== undefined && incompatible(value)) {
            widened = true;
            break;
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return widened
    ? { kind: "ref_null", typeIdx: getOrRegisterVecType(ctx, "externref", { kind: "externref" }) }
    : undefined;
}

/**
 * (#6651 U4) Compile a rebind-widened binding's `[…]` initializer straight into
 * the widened `externref`-element vec. Left to the checker's element type, the
 * literal is built as e.g. `$__vec_i32` and then converted element-wise into the
 * slot, which re-boxes `true` as the NUMBER 1. Returns the literal the caller
 * should compile with an `externref` element hint, or undefined when the
 * declaration is not a widened array-literal binding. (The caller compiles it:
 * importing `literals.js` here would pull this leaf into the import-cycle SCC.)
 */
export function rebindWidenedArrayInit(
  ctx: CodegenContext,
  decl: ts.VariableDeclaration,
  slotType: ValType,
): ts.ArrayLiteralExpression | undefined {
  const init = decl.initializer;
  if (init === undefined || !ts.isArrayLiteralExpression(init) || !ts.isIdentifier(decl.name)) return undefined;
  if (!isModuleScoped(decl) || !widenedVarsOf(ctx, decl.getSourceFile()).has(decl.name.text)) return undefined;
  if (init.elements.some((element) => ts.isSpreadElement(element) || ts.isOmittedExpression(element))) return undefined;
  // Only when the slot really is the widened vec (an earlier arm may have chosen another).
  const widenedIdx = getOrRegisterVecType(ctx, "externref", { kind: "externref" });
  if ((slotType.kind !== "ref" && slotType.kind !== "ref_null") || slotType.typeIdx !== widenedIdx) return undefined;
  return init;
}

/**
 * (#6651 U4) The field type for an object-literal property whose value is a
 * widened module-scoped array binding (`{ value: item }`): that binding's own
 * carrier, so the store ALIASES the array.
 *
 * An anonymous struct field is typed from the CHECKER (`string[]` → a string
 * vec) while a widened binding lives in an `externref`-element vec, so the store
 * copied the array element-wise and the property no longer held `item` itself:
 * `({ v: item }).v === item` was false, and an accessor installed on `item[0]`
 * (keyed by vec identity) was invisible through the copy. That is how
 * `new Map(iterable)` never saw `Get(item, "0")` throw in
 * `Map/iterator-item-first-entry-returns-abrupt.js` and spun to the step cap.
 * Any other property keeps `fieldType`.
 */
export function propertyValueWidenedArrayCarrier(ctx: CodegenContext, prop: ts.Symbol, fieldType: ValType): ValType {
  if (fieldType.kind !== "ref" && fieldType.kind !== "ref_null") return fieldType;
  for (const declaration of prop.declarations ?? []) {
    if (!ts.isPropertyAssignment(declaration)) continue;
    let value: ts.Expression = declaration.initializer;
    while (ts.isParenthesizedExpression(value)) value = value.expression;
    if (!ts.isIdentifier(value)) continue;
    const decl = ctx.oracle.variableDeclarationOf(value);
    if (decl === undefined || !isModuleScoped(decl) || !ts.isVariableStatement(decl.parent.parent)) continue;
    const carrier = rebindWidenedArrayVecType(ctx, decl.getSourceFile(), decl);
    if (carrier === undefined || (carrier.kind !== "ref" && carrier.kind !== "ref_null")) continue;
    // An earlier `moduleGlobalWasmType` arm may have chosen another slot; alias
    // only into the slot the binding really has.
    const globalIdx = ts.isIdentifier(decl.name) ? ctx.moduleGlobals.get(decl.name.text) : undefined;
    const slot = globalIdx === undefined ? undefined : ctx.mod.globals[globalIdx - ctx.numImportGlobals]?.type; // = localGlobalIdx (inlined: registry/imports.js is inside the import-cycle SCC)
    if (slot !== undefined && (slot.kind !== carrier.kind || slot.typeIdx !== carrier.typeIdx)) continue;
    return carrier;
  }
  return fieldType;
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
 * `new Array(len)` length form): carries no element evidence, and — unlike an
 * unclassifiable `null` result — does not abandon the binding.
 */
function writtenElementTags(ctx: CodegenContext, expr: ts.Expression): readonly WriteTag[] | undefined | null {
  if (ts.isArrayLiteralExpression(expr)) {
    if (expr.elements.length === 0) return undefined;
    const tags: WriteTag[] = [];
    for (const element of expr.elements) {
      if (ts.isSpreadElement(element) || ts.isOmittedExpression(element)) return null;
      // Keep null separate from ordinary objects: null can share the
      // externref element carrier, but it cannot be represented by a closed
      // object struct (and `typeof null` otherwise hides this distinction).
      if (element.kind === ts.SyntaxKind.NullKeyword) {
        tags.push("nullish");
      } else {
        const tag = ctx.oracle.staticJsTypeOf(element);
        if (tag === "mixed") return null;
        tags.push(tag);
      }
    }
    return tags;
  }
  if (ts.isNewExpression(expr) || ts.isCallExpression(expr)) {
    const callee = expr.expression;
    if (!ts.isIdentifier(callee) || callee.text !== "Array") return null;
    const args = expr.arguments;
    if (args === undefined || args.length === 0) return undefined;
    const tags: WriteTag[] = [];
    for (const argument of args) {
      if (ts.isSpreadElement(argument)) return null;
      if (argument.kind === ts.SyntaxKind.NullKeyword) {
        tags.push("nullish");
      } else {
        const tag = ctx.oracle.staticJsTypeOf(argument);
        if (tag === "mixed") return null;
        tags.push(tag);
      }
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
function writeDomain(tags: readonly WriteTag[] | undefined): WriteDomain | undefined {
  if (tags === undefined || tags.length === 0) return undefined;
  const objectElements = tags.filter((tag) => tag !== "nullish" && OBJECT_TAGS.has(tag)).length;
  const nullishElements = tags.filter((tag) => tag === "nullish").length;
  // A null-containing write needs the universal element carrier even when all
  // its other values are primitive. Treat that representation as object-domain
  // evidence so a preceding numeric/boolean/string write widens the rebinding.
  if (nullishElements > 0) {
    const nonNullElements = tags.length - nullishElements;
    if (objectElements === 0 || objectElements === nonNullElements) return "object";
  }
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

  /** name → module-scoped bindings it was assigned from (`x = y`). */
  const aliases = new Map<string, Set<string>>();

  const record = (name: string, value: ts.Expression): void => {
    if (seen.get(name) === null) return;
    const source = aliasSourceOf(ctx, sourceFile, value);
    if (source !== undefined) {
      // (#6651 U4) `x = y` / `x = null` carries no element evidence of its
      // own; an identifier source joins `y`'s group below.
      if (!seen.has(name)) seen.set(name, new Set());
      if (source !== null) aliases.set(name, (aliases.get(name) ?? new Set()).add(source));
      return;
    }
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

  // (#6651 U4) Bindings assigned to one another hold the SAME array objects,
  // so they must share one element carrier: a vec→vec store between two
  // element types copies and converts instead of aliasing — `second = third`
  // turned `[null, undefined]` into `[false, false]` (test262 `for-of/map.js`).
  // Union the alias groups and decide per group; an abandoned member abandons
  // its whole group, which keeps today's types for every member.
  const parent = new Map<string, string>();
  const find = (name: string): string => {
    let root = name;
    for (let next = parent.get(root); next !== undefined; next = parent.get(root)) root = next;
    return root;
  };
  const members = new Set<string>(seen.keys());
  for (const [name, sources] of aliases) {
    members.add(name);
    for (const source of sources) {
      members.add(source);
      const a = find(name);
      const b = find(source);
      if (a !== b) parent.set(a, b);
    }
  }
  const groupDomains = new Map<string, Set<WriteDomain> | null>();
  for (const name of members) {
    const root = find(name);
    const domains = seen.get(name);
    if (domains === null || groupDomains.get(root) === null) {
      groupDomains.set(root, null);
      continue;
    }
    const acc = groupDomains.get(root) ?? new Set<WriteDomain>();
    for (const domain of domains ?? []) acc.add(domain);
    groupDomains.set(root, acc);
  }

  const widened = new Set<string>();
  for (const name of members) {
    const domains = groupDomains.get(find(name));
    if (domains && domains.has("object") && domains.has("primitive")) widened.add(name);
  }
  return widened;
}

/**
 * (#6651 U4) The module-scoped `var` binding a whole-value write aliases
 * (`x = y`), `null` for a nullish write (`x = null` — no element evidence),
 * or `undefined` for any other shape.
 */
function aliasSourceOf(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile,
  value: ts.Expression,
): string | null | undefined {
  let expr = value;
  while (ts.isParenthesizedExpression(expr)) expr = expr.expression;
  if (expr.kind === ts.SyntaxKind.NullKeyword) return null;
  if (!ts.isIdentifier(expr)) return undefined;
  if (expr.text === "undefined") return null;
  const decl = ctx.oracle.variableDeclarationOf(expr);
  if (
    decl === undefined ||
    !ts.isIdentifier(decl.name) ||
    decl.getSourceFile() !== sourceFile ||
    !isModuleScoped(decl) ||
    !ts.isVariableStatement(decl.parent.parent)
  ) {
    return undefined;
  }
  return decl.name.text;
}
