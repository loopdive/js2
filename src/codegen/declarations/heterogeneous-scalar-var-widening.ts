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
import type { ValType } from "../../ir/types.js";
import {
  collectHeterogeneouslyAssignedModuleVarNames,
  HETEROGENEOUS_PRIMITIVE_SLOT_TAGS,
} from "../../ir/heterogeneous-module-bindings.js";
import {
  updateRetypesModuleBinding,
  updateRetypesModuleBindingName,
  updateRetypesModuleIdentifier,
} from "../../ir/update-retyped-bindings.js";
import { ts } from "../../ts-api.js";
import type { CodegenContext } from "../context/types.js";
import { localGlobalIdx } from "../registry/imports.js";
import { reassignedFunctionBindingIsDynamic } from "./reassigned-function-binding-widening.js";

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
  // The mirror image of the primitive-slot case below: a REFERENCE-initialized
  // binding assigned a primitive. See {@link referenceSlotReceivesPrimitive}.
  if (referenceSlotReceivesPrimitive(ctx.oracle, decl)) return { kind: "externref" };
  const widened = collectHeterogeneouslyAssignedModuleVarNames(ctx.oracle, sourceFile);
  // Deliberately does NOT tag `externrefAccessorVars`: this is a value-carrier
  // widening, not a host-property-access reroute.
  return widened.has(decl.name.text) ? { kind: "externref" } : undefined;
}

/** Compound assignments whose write-back is always a Number or a BigInt. */
const NUMERIC_COMPOUND_ASSIGNMENTS: ReadonlySet<ts.SyntaxKind> = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.AsteriskAsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.PercentEqualsToken,
  ts.SyntaxKind.LessThanLessThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.AmpersandEqualsToken,
  ts.SyntaxKind.BarEqualsToken,
  ts.SyntaxKind.CaretEqualsToken,
]);

/**
 * The mirror image of the primitive-slot widening above: a module `var`/`let`
 * whose *reference* initializer pins a concrete struct/vec slot, and which some
 * assignment stores a *primitive* into.
 *
 * `let x = { a: 1 }` types `__mod_x` as `(ref null $obj)` from the initializer,
 * so a later `x = true` has nowhere to go. `coerceType`'s terminal fallback is
 * `drop` + `pushDefaultValue`, and the module emits
 *
 *     i32.const 1     ;; the boolean
 *     drop            ;; discarded
 *     ref.null $obj   ;; stored instead
 *
 * which VALIDATES. Every read after the assignment silently answers `null` —
 * the same class of loss #4204 fixed on the primitive side, in the other
 * direction. Object, array and `new C()` initializers are all affected;
 * function-local `let` is not, because only the module-global typer pins the
 * slot from the initializer.
 *
 * Deliberately narrower than {@link assignmentWidens}: it fires only on a tag
 * disagreement the compiler can PROVE, never on `mixed`. An object slot that
 * receives an unconstrainable value is the overwhelmingly common shape in real
 * module code (`let cache = {}; cache = load()`), it is already lowered
 * correctly, and widening it would be a representation change on a hot path
 * bought with no evidence. `null` is not a widening trigger either — a nullable
 * reference already carries it, and `typeof null` is `"object"` so the tag
 * comparison excludes it on its own.
 */
function referenceSlotReceivesPrimitive(ctx: CodegenContext["oracle"], decl: ts.VariableDeclaration): boolean {
  // An explicit annotation is the representation contract (same rule the
  // primitive-side collector applies to its own initializer tag).
  if (decl.type !== undefined || decl.initializer === undefined) return false;
  if (!ts.isIdentifier(decl.name) || !isModuleScoped(decl)) return false;
  const list = decl.parent;
  if (!ts.isVariableDeclarationList(list) || (list.flags & ts.NodeFlags.Const) !== 0) return false;
  // Only a reference initializer pins a slot that cannot box a primitive. A
  // `function` tag is excluded on purpose: closure-typed globals already carry
  // the value correctly today, so widening them would move working code.
  if (ctx.staticJsTypeOf(decl.initializer) !== "object") return false;

  let receivesPrimitive = false;
  const writesPrimitive = (assigned: ts.Expression): boolean => {
    const tag = ctx.staticJsTypeOf(assigned);
    return tag !== "mixed" && tag !== "object" && tag !== "function";
  };
  const targetsThisBinding = (target: ts.Expression): boolean =>
    ts.isIdentifier(target) && ctx.variableDeclarationOf(target) === decl;

  // The walk crosses nested functions: a callback body writes the same binding.
  const visit = (node: ts.Node): void => {
    if (receivesPrimitive) return;
    if (ts.isBinaryExpression(node) && targetsThisBinding(node.left)) {
      if (node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        if (writesPrimitive(node.right)) {
          receivesPrimitive = true;
          return;
        }
      } else if (NUMERIC_COMPOUND_ASSIGNMENTS.has(node.operatorToken.kind)) {
        // These write back the result of ToNumeric/ToBigInt by definition. The
        // logical forms (`||=`, `&&=`, `??=`) are deliberately absent: they
        // store the right operand unchanged, which may well be a reference.
        receivesPrimitive = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(decl.getSourceFile());
  return receivesPrimitive;
}

/**
 * JS tags whose values the compiler stores in a *non*-`externref` slot chosen
 * from the initializer: `f64` for number, `i32` for boolean, `i64` for bigint,
 * `(ref null $string)` for string. These are exactly the slots that cannot
 * carry a value of another tag.
 */
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
  // (#4491 T12) The FunctionDeclaration binding carries the identical hazard
  // and `variableDeclarationOf` below cannot see it — see
  // reassigned-function-binding-widening.ts.
  if (reassignedFunctionBindingIsDynamic(ctx, id)) return true;
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
  return tag !== "mixed" && HETEROGENEOUS_PRIMITIVE_SLOT_TAGS.has(tag);
}

/**
 * Keep a closure's result ABI aligned with a module binding whose storage was
 * widened after heterogeneous assignment. The checker still infers the
 * binding's initializer type, so a getter such as `function () { return x; }`
 * would otherwise narrow an externref value back to that stale primitive type
 * at the function boundary.
 */
export function widenClosureReturnForDynamicModuleBinding(
  ctx: CodegenContext,
  fn: ts.SignatureDeclaration & { body?: ts.Node },
  inferred: ValType,
): ValType {
  if (inferred.kind === "externref" || fn.body === undefined) return inferred;

  let returnsDynamicBinding = false;
  const visit = (node: ts.Node): void => {
    if (returnsDynamicBinding) return;
    if (node !== fn && ts.isFunctionLike(node)) return;
    if (
      ts.isReturnStatement(node) &&
      node.expression !== undefined &&
      ts.isIdentifier(node.expression) &&
      moduleGlobalIsDynamicButStaticallyPrimitive(ctx, node.expression)
    ) {
      returnsDynamicBinding = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(fn.body);
  return returnsDynamicBinding ? { kind: "externref" } : inferred;
}

/** True when `node` is hoisted to module scope — i.e. no function-like ancestor. */
function isModuleScoped(node: ts.Node): boolean {
  for (let parent = node.parent; parent !== undefined && !ts.isSourceFile(parent); parent = parent.parent) {
    if (
      ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isArrowFunction(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent) ||
      ts.isConstructorDeclaration(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isClassExpression(parent) ||
      ts.isModuleDeclaration(parent)
    ) {
      return false;
    }
  }
  return true;
}
