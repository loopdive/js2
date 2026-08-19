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
 * change on a hot path, so the analysis fires on a disagreement the compiler
 * can actually establish: the initializer's static JS tag must be a known
 * primitive, and the assigned expression must not be provably that same tag.
 *
 * (#4206) A `mixed` (unresolvable / union / `any`) RHS therefore DOES widen.
 * The original rule refused it on the grounds that an unknown tag is not
 * evidence of heterogeneity; that reading is unsound, because storing an
 * unconstrainable value into a `string` slot yields `null` and traps in
 * `__str_concat` on the next concatenation. See {@link assignmentWidens} for
 * the measurement that retired the "widens a large fraction of the corpus"
 * concern.
 *
 * Binding identity comes from `oracle.variableDeclarationOf`, not from the
 * name, so a same-named local in an unrelated function cannot force a module
 * global to widen (the #3364 bare-name-keying failure mode).
 */
import type { JsTag } from "../../checker/oracle.js";
import type { ValType } from "../../ir/types.js";
import {
  updateRetypesModuleBinding,
  updateRetypesModuleBindingName,
  updateRetypesModuleIdentifier,
} from "../../ir/update-retyped-bindings.js";
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
  // #4208 S2 — `++` / `--` always stores the result of ToNumeric back into
  // the target. A string, Boolean, wrapper or ordinary object initializer may
  // therefore need to coexist with a later Number even without an explicit
  // assignment. IR owns the binding-identity proof; direct codegen uses the
  // same verdict so a conservatively demoted module initializer keeps the
  // representation chosen during selection.
  if (updateRetypesModuleBinding(ctx.oracle, decl)) return { kind: "externref" };
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
  // Sloppy-script `var` redeclarations make the oracle's singular declaration
  // lookup intentionally return undefined. The update analysis is
  // symbol/declaration-set based, so it remains exact for that legal binding
  // shape and prevents stale checker types from selecting a string/Boolean
  // comparison after the update has stored a Number.
  if (
    updateRetypesModuleIdentifier(ctx.oracle, id) ||
    (isModuleScoped(id) && updateRetypesModuleBindingName(ctx.oracle, id.getSourceFile(), id.text))
  ) {
    return true;
  }
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
 * A bare `this` widens because §10.4.3's receiver is a *runtime* value the
 * callee cannot constrain: `Object.defineProperty(o, "foo", { set: function (v)
 * { x = this; } })` stores the receiver object into `x`.
 *
 * ## (#4206) `mixed` widens too — the original refusal was unsound
 *
 * This predicate used to answer `false` for a `mixed` RHS, on the stated
 * grounds that "an unresolvable RHS is not evidence of heterogeneity, and
 * widening on it would pull a large fraction of the corpus onto the dynamic
 * representation for no measured benefit". Both halves are wrong:
 *
 * - **It is not a coverage gap, it is a lossy store.** A `mixed` value is by
 *   construction one the compiler cannot constrain, so the narrow slot may
 *   simply be unable to hold it. Into a `string` slot — `(ref null $AnyString)`
 *   — a non-string coerces to **null**, a value the binding could never
 *   legitimately have received, and the next `"" + x` traps in `__str_concat`
 *   on a null deref. That crash was the single largest signature in the ES5
 *   standalone residue.
 * - **The corpus cost is measured and is ~nil.** Over 73 compiled
 *   `language/{statements,expressions}` files, exactly **one** module changed a
 *   byte, and it got 125 bytes *smaller*. Over a 1,200-file standalone A/B the
 *   only status changes at all were three crashes turning into passes: zero
 *   pass→fail, zero altered failure signatures.
 *
 * So a `mixed` RHS is treated the same way a `this` receiver already was, and
 * for the same reason: a value no static tag can constrain must not be squeezed
 * through a representation chosen from the initializer alone.
 */
function assignmentWidens(ctx: CodegenContext, declTag: JsTag, assigned: ts.Expression): boolean {
  if (assigned.kind === ts.SyntaxKind.ThisKeyword) return true;
  const assignedTag = ctx.oracle.staticJsTypeOf(assigned);
  // (#4206) `mixed` is unconstrainable, not "probably the same tag" — see above.
  if (assignedTag === "mixed") return true;
  return assignedTag !== declTag;
}

/**
 * (#4264) True when `node` sits inside the BODY of a `with` statement.
 *
 * Deliberately does NOT stop at a function boundary: a module global written
 * from inside a `with` nested in a function loses its value the same way one
 * written at top level does.
 */
function isInsideWithBody(node: ts.Node): boolean {
  let prev: ts.Node | undefined;
  for (let cur: ts.Node | undefined = node; cur; prev = cur, cur = cur.parent) {
    if (prev !== undefined && ts.isWithStatement(cur) && cur.statement === prev) return true;
  }
  return false;
}

/**
 * (#4264) Every module-scoped `var`/`let` in this file, by name.
 *
 * Only built for a file that actually contains a `with` — see
 * {@link withBodyAssignmentWidens} for why the name-keyed lookup is admissible
 * there and nowhere else, and CLAUDE.md's `#3364` note for why bare-name keying
 * is otherwise forbidden.
 */
function collectModuleScopedVarsByName(sourceFile: ts.SourceFile): Map<string, ts.VariableDeclaration> {
  const byName = new Map<string, ts.VariableDeclaration>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && isModuleScoped(node)) {
      if (!byName.has(node.name.text)) byName.set(node.name.text, node);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return byName;
}

/**
 * (#4264) Widen a primitive-pinned module global assigned from inside a `with`
 * body.
 *
 * ## Why the #4204 predicate cannot see this write
 *
 * Inside a `with` body the checker resolves NOTHING — §14.11's object
 * Environment Record can bind any name at runtime, so TypeScript gives every
 * identifier there `any` and no value declaration. So both halves of the #4204
 * test fail at once: `variableDeclarationOf(target)` is `undefined`, and the
 * RHS's tag is `mixed`. The slot therefore keeps the initializer's narrow
 * representation and the assignment is destroyed by coercion:
 *
 * ```js
 * var st = "parseInt";                    // (mut (ref null $string))
 * with (o) { st = parseInt; }             // o owns parseInt ⇒ a function
 * st === parseInt                         // true — both read back null
 * ```
 *
 * That single mechanism is what stalls the whole `S12.10_A1.*` battery at
 * assertion #11 (`myObj.parseInt !== parseInt`): the value the object
 * environment supplied never survives the store.
 *
 * ## Why `mixed` widens HERE but not in the #4204 rule
 *
 * #4204 refuses to widen on `mixed` because an unresolvable RHS is not evidence
 * of heterogeneity. Inside a `with` body it is not merely unresolvable — it is
 * dynamically resolved *by construction*, and no static tag can constrain it.
 * That is the same reasoning #4204 already applies to a bare `this` receiver,
 * applied to the one other construct the spec defines as dynamically scoped.
 *
 * ## Blast radius
 *
 * A file with no `with` statement never reaches this predicate, so its globals
 * are typed byte-identically to before. Within a `with`-bearing file it widens
 * only bindings whose slot is a primitive AND whose target the oracle could not
 * resolve (a resolved target keeps #4204's precise verdict, including a
 * deliberate refusal).
 */
function withBodyAssignmentWidens(
  ctx: CodegenContext,
  target: ts.Identifier,
  moduleVarsByName: Map<string, ts.VariableDeclaration>,
  initializerTagOf: (decl: ts.VariableDeclaration) => JsTag | "none",
): boolean {
  if (ctx.oracle.variableDeclarationOf(target) !== undefined) return false;
  if (!isInsideWithBody(target)) return false;
  const named = moduleVarsByName.get(target.text);
  return named !== undefined && initializerTagOf(named) !== "none";
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
  // (#4264) Demand-gate: only a file that actually contains a `with` pays for
  // the name-keyed fallback, and only such a file can change representation.
  const moduleVarsByName = sourceFile.text.includes("with")
    ? collectModuleScopedVarsByName(sourceFile)
    : new Map<string, ts.VariableDeclaration>();
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
      } else if (
        moduleVarsByName.size > 0 &&
        withBodyAssignmentWidens(ctx, node.left, moduleVarsByName, initializerTagOf)
      ) {
        widened.add(node.left.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return widened;
}
