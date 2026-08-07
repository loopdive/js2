// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4204) Module-global representation widening for a PRIMITIVE-initialized
 * `var`/`let` that is later assigned a value of a different JS type.
 *
 * ## The defect
 *
 * `moduleGlobalWasmType` (declarations.ts) commits a top-level binding's Wasm
 * slot from its *initializer* alone: `var x = 2` becomes
 * `(global $__mod_x (mut f64))`. A later `x = {}` / `x = this` / `x = "s"` then
 * has to squeeze a reference through an `f64` slot, and the coercion yields
 * `NaN` — silently, with no diagnostic. §10.4.3's setter-`this` tests read as
 * "the setter's receiver is wrong" for exactly this reason; the receiver is
 * fine, the *binding* lost the value on the way in.
 *
 * ## Why widening to `externref` is the right lowering, not new machinery
 *
 * A bare `var x;` ALREADY gets `(mut externref)` — `getTypeAtLocation` says
 * `any` and `resolveWasmType` maps that to externref. That representation is
 * fully exercised in standalone today: numbers round-trip through it, and so do
 * arithmetic, `typeof`, string concatenation, relational compare and `for`-loop
 * counters. So the fix is to route the heterogeneously-assigned binding onto the
 * representation the compiler already has, at the one place that picks it.
 *
 * ## Why the predicate is deliberately narrow
 *
 * Every global that changes from `f64` to `externref` is a representation
 * change on a hot path, so the analysis only fires on a PROVABLE disagreement:
 * both the initializer's and the assigned expression's static JS tags must be
 * known, and they must differ. A `mixed` (unresolvable / union / `any`) RHS
 * does NOT widen — an unknown tag is not evidence of heterogeneity, and
 * treating it as such would widen a large fraction of the corpus for no
 * measured benefit.
 *
 * Binding identity comes from `oracle.variableDeclarationOf`, not from the
 * name, so a same-named local in an unrelated function cannot force a module
 * global to widen (the #3364 bare-name-keying failure mode).
 */
import type { JsTag } from "../../checker/oracle.js";
import type { ValType } from "../../ir/types.js";
import { ts } from "../../ts-api.js";
import type { CodegenContext } from "../context/types.js";
import { localGlobalIdx } from "../registry/imports.js";

/**
 * Per-(context, file) memo. The analysis walks the whole source file and
 * `moduleGlobalWasmType` asks once per declaration, so without this a file with
 * N module vars would walk itself N times. Keyed by context first because an
 * incremental compiler reuses `ts.SourceFile` objects across programs.
 */
const analysisCache = new WeakMap<CodegenContext, Map<ts.SourceFile, ReadonlySet<string>>>();

/**
 * The widened slot type for `decl`, or `undefined` to leave the type picker's
 * decision alone. Memoizing entry point for `moduleGlobalWasmType`.
 */
export function heterogeneousWidenedModuleGlobalType(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile,
  decl: ts.VariableDeclaration,
): ValType | undefined {
  if (!ts.isIdentifier(decl.name)) return undefined;
  let perFile = analysisCache.get(ctx);
  if (perFile === undefined) {
    perFile = new Map();
    analysisCache.set(ctx, perFile);
  }
  let widened = perFile.get(sourceFile);
  if (widened === undefined) {
    widened = collectHeterogeneouslyAssignedModuleVars(ctx, sourceFile);
    perFile.set(sourceFile, widened);
  }
  // Deliberately does NOT tag `externrefAccessorVars`: this is a value-carrier
  // widening, not a host-property-access reroute.
  return widened.has(decl.name.text) ? { kind: "externref" } : undefined;
}

/**
 * JS tags whose values the compiler stores in a *non*-`externref` slot chosen
 * from the initializer: `f64` for number, `i32` for boolean, `i64` for bigint,
 * `(ref null $string)` for string. These are exactly the slots that cannot
 * carry a value of another tag.
 */
const PRIMITIVE_SLOT_TAGS: ReadonlySet<JsTag> = new Set<JsTag>(["number", "string", "boolean", "bigint"]);

/**
 * (#4204) Is this identifier a module binding whose Wasm slot is DYNAMIC while
 * the checker still describes it as a primitive?
 *
 * A widened binding keeps its initializer-derived checker type — `var x = 2`
 * stays `number` to TypeScript even after `x = this` forces the slot to
 * `externref`. Any consumer that CONST-FOLDS from the checker type is therefore
 * unsound on such a binding, and `typeof` is the one that shows: it folds to the
 * literal `"number"` and never reads the value at all. Folds that instead
 * *lower* from the checker type are fine — they go through the ordinary
 * externref coercions and observe the real value (verified for `+`, relational
 * compare, string concat, `switch`, strict-eq, `Math.max`, `.toFixed` and
 * `for`-loop counters).
 *
 * Phrased as a representation-vs-static-type disagreement rather than as a
 * #4204 flag so it also covers the pre-existing externref overrides (#2011 /
 * #2837 / #3369), which carry the same latent mismatch. Binding identity comes
 * from the oracle, so a same-named function local cannot consult a global.
 */
export function moduleGlobalIsDynamicButStaticallyPrimitive(ctx: CodegenContext, id: ts.Identifier): boolean {
  const globalIdx = ctx.moduleGlobals.get(id.text);
  if (globalIdx === undefined) return false;
  if (ctx.mod.globals[localGlobalIdx(ctx, globalIdx)]?.type.kind !== "externref") return false;
  const decl = ctx.oracle.variableDeclarationOf(id);
  if (decl === undefined || !ts.isIdentifier(decl.name) || !isModuleScoped(decl)) return false;
  const tag = ctx.oracle.staticJsTypeOf(id);
  return tag !== "mixed" && PRIMITIVE_SLOT_TAGS.has(tag);
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
 * Does storing `assigned` into a slot pinned to `declTag` need a wider carrier?
 *
 * Two admissible answers, and `mixed` is deliberately NOT one of them: an
 * unresolvable RHS is not evidence of heterogeneity, and widening on it would
 * pull a large fraction of the corpus onto the dynamic representation for no
 * measured benefit.
 *
 * The one named exception is a bare `this`. In a non-arrow function TypeScript
 * declines to type it (`any` → `mixed`), but §10.4.3's receiver is a *runtime*
 * value the callee cannot constrain: `Object.defineProperty(o, "foo", { set:
 * function (v) { x = this; } })` stores the receiver object into `x`. Treating
 * `mixed` broadly as widening would be unjustified; treating a `this` receiver
 * as never-provably-this-primitive is exactly what the spec says.
 */
function assignmentWidens(ctx: CodegenContext, declTag: JsTag, assigned: ts.Expression): boolean {
  if (assigned.kind === ts.SyntaxKind.ThisKeyword) return true;
  const assignedTag = ctx.oracle.staticJsTypeOf(assigned);
  return assignedTag !== "mixed" && assignedTag !== declTag;
}

/**
 * Names of module-scoped `var`/`let` bindings whose primitive-pinned slot is
 * provably too narrow for some assignment in this source file.
 *
 * The walk covers the WHOLE file, nested functions included: a module global is
 * routinely written from inside a function (`{ set foo(v) { x = this; } }` is
 * the §10.4.3 shape), and that write is exactly the one that loses the value.
 */
export function collectHeterogeneouslyAssignedModuleVars(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile,
): ReadonlySet<string> {
  const widened = new Set<string>();
  /** Declaration → its initializer tag, or `undefined` when it cannot widen. */
  const declTagCache = new WeakMap<ts.VariableDeclaration, JsTag | "none">();

  const initializerTagOf = (decl: ts.VariableDeclaration): JsTag | "none" => {
    const cached = declTagCache.get(decl);
    if (cached !== undefined) return cached;
    let tag: JsTag | "none" = "none";
    if (decl.initializer !== undefined && ts.isIdentifier(decl.name) && isModuleScoped(decl)) {
      const declared = ctx.oracle.staticJsTypeOf(decl.initializer);
      if (declared !== "mixed" && PRIMITIVE_SLOT_TAGS.has(declared)) tag = declared;
    }
    declTagCache.set(decl, tag);
    return tag;
  };

  const visit = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left) &&
      !widened.has(node.left.text)
    ) {
      const decl = ctx.oracle.variableDeclarationOf(node.left);
      // `getSourceFile()` keeps a cross-file binding of the same name from
      // widening a global this file owns; `collectDeclarations` only registers
      // globals for declarations it can see here.
      if (decl !== undefined && decl.getSourceFile() === sourceFile) {
        const declTag = initializerTagOf(decl);
        if (declTag !== "none" && assignmentWidens(ctx, declTag, node.right)) widened.add(node.left.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return widened;
}
