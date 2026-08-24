// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4491 wave-5 T4) Module-global representation widening for a `var` that is
 * REDECLARED at module scope with an initializer of a different JS tag.
 *
 * ## The defect
 *
 * `var x = true; … var x = function () {};` is ONE binding in JavaScript — the
 * second `var` re-uses the first slot and only its initializer runs, in source
 * order. The compiler picks that slot's Wasm type once, from the checker's view
 * of the symbol, and the checker's view is dominated by the *function*
 * declaration. `var x = true` then has to squeeze an `i32` through a
 * `(ref null $closure)` slot, and `coerceType` answers `ref.null` — the
 * initializer is compiled and then **dropped**:
 *
 * ```wat
 * i32.const 1     ;; `true`
 * drop            ;; thrown away
 * ref.null 47
 * global.set 7    ;; x := null
 * ```
 *
 * Every later read is that null. `typeof x` still folds to `"boolean"` from the
 * checker type, so the value and its tag disagree and nothing reports an error:
 * `x === true` is false, `x === false` is false, `"" + x` is `"[object Object]"`
 * and `x ? … : …` takes the falsy arm. Measured on `S11.1.5_A2` (the sputnik
 * "property of various types" test): checks 1–10 pass in isolation and CHECK#1
 * starts failing the moment CHECK#11's `var x = function () {}` is appended,
 * ten checks earlier in the file.
 *
 * ## Why this is not already covered by #4204 / #4206
 *
 * {@link collectHeterogeneouslyAssignedModuleVarNames} asks exactly the right
 * question — "can a later value outgrow the slot the initializer chose?" — but
 * only of `BinaryExpression` assignment nodes (`x = …`). A redeclaration is not
 * an assignment expression, so the identical hazard arrives through a syntactic
 * carrier the walk never visits, and that analysis's own
 * `collectModuleScopedVarsByName` deliberately keeps only the FIRST declaration
 * per name. This module is the declaration-vs-declaration half of the same rule
 * and reuses its tag set and its `mixed`-widens verdict so the two halves cannot
 * drift apart.
 *
 * ## Why the predicate is deliberately narrow
 *
 * Widening a global from `f64`/`i32` to `externref` is a representation change
 * on a hot path, so this fires only when the compiler can establish the clash:
 *
 * - module scope only (a function-local `var` gets a local slot, not a global);
 * - at least TWO declarations of the name in this file (redeclaration is the
 *   whole subject);
 * - at least one of them initializes to a *specialized-slot* primitive tag
 *   (`number` / `string` / `boolean` / `bigint`) — those are exactly the slots
 *   that cannot carry another tag;
 * - and some other declaration's initializer has a different tag, `mixed`
 *   included (an unconstrainable initializer is not evidence the tag holds —
 *   the #4206 reading).
 *
 * Declarations with an explicit TypeScript annotation are skipped for the same
 * reason #4204 skips them: the annotation is the representation contract, and
 * widening away from it would make codegen disagree with the checker-backed IR
 * binding ABI. A declaration with no initializer contributes nothing (it is the
 * hoisted `undefined`, which every slot already has to represent).
 */
import { HETEROGENEOUS_PRIMITIVE_SLOT_TAGS } from "../../ir/heterogeneous-module-bindings.js";
import { TsCheckerOracle, type JsTag, type TypeOracle } from "../../checker/oracle.js";
import { ts } from "../../ts-api.js";
import type { ValType } from "../../ir/types.js";
import type { CodegenContext } from "../context/types.js";

type RedeclarationOracle = Pick<TypeOracle, "staticJsTypeOf">;
type RedeclarationQuerySource = ts.TypeChecker | RedeclarationOracle;

const checkerOracles = new WeakMap<ts.TypeChecker, RedeclarationOracle>();
const analysisCache = new WeakMap<object, WeakMap<ts.SourceFile, ReadonlySet<string>>>();

function queryOracle(source: RedeclarationQuerySource): RedeclarationOracle {
  if ("staticJsTypeOf" in source) return source;
  let oracle = checkerOracles.get(source);
  if (!oracle) {
    oracle = new TsCheckerOracle(source);
    checkerOracles.set(source, oracle);
  }
  return oracle;
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

/**
 * Names of module `var` bindings declared more than once in this file with
 * initializers whose JS tags disagree, at least one of them a specialized-slot
 * primitive.
 */
export function collectRedeclarationWidenedModuleVarNames(
  source: RedeclarationQuerySource,
  sourceFile: ts.SourceFile,
): ReadonlySet<string> {
  const oracle = queryOracle(source);
  let bySource = analysisCache.get(oracle);
  if (!bySource) {
    bySource = new WeakMap();
    analysisCache.set(oracle, bySource);
  }
  const cached = bySource.get(sourceFile);
  if (cached) return cached;

  // name -> initializer tags observed at module scope, in source order.
  const tagsByName = new Map<string, (JsTag | "mixed")[]>();
  // name -> how many module-scoped declarations carry the name at all, so a
  // single declaration can never widen on its own.
  const declCountByName = new Map<string, number>();

  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      !(node.parent.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) &&
      isModuleScoped(node)
    ) {
      const name = node.name.text;
      declCountByName.set(name, (declCountByName.get(name) ?? 0) + 1);
      if (node.type === undefined && node.initializer !== undefined) {
        const tags = tagsByName.get(name);
        const tag = oracle.staticJsTypeOf(node.initializer);
        if (tags) tags.push(tag);
        else tagsByName.set(name, [tag]);
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);

  const widened = new Set<string>();
  for (const [name, tags] of tagsByName) {
    if ((declCountByName.get(name) ?? 0) < 2) continue;
    if (tags.length < 2) continue;
    // A specialized primitive slot is the only slot that loses the value; a
    // clash between two reference tags is already carried by the ref lowering.
    if (!tags.some((tag) => tag !== "mixed" && HETEROGENEOUS_PRIMITIVE_SLOT_TAGS.has(tag))) continue;
    if (tags.some((tag) => tag !== tags[0])) widened.add(name);
  }

  bySource.set(sourceFile, widened);
  return widened;
}

/**
 * The widened slot type for `decl`, or `undefined` to leave the type picker's
 * decision alone. Entry point for `moduleGlobalWasmType` (declarations.ts).
 */
export function redeclarationWidenedModuleGlobalType(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile,
  decl: ts.VariableDeclaration,
): ValType | undefined {
  if (!ts.isIdentifier(decl.name)) return undefined;
  return collectRedeclarationWidenedModuleVarNames(ctx.oracle, sourceFile).has(decl.name.text)
    ? { kind: "externref" }
    : undefined;
}

/**
 * The `__module_init` SHADOW-LOCAL type for `decl`, or `undefined` to leave the
 * local type cascade alone.
 *
 * The global and its module-init local are one binding and must carry one
 * representation. Without this the two disagree in a way that is not even
 * expressible as Wasm: the closure declaration allocates the shadow local as
 * `externref` (`variables.ts`, the `globalIsExternref` arm), a later
 * redeclaration re-enters the generic local path — where the checker still
 * reports the SYMBOL's type, i.e. the FIRST declaration's `boolean` — and the
 * retype ladder narrows the slot to `i32`. The already-emitted
 * `local.tee; global.set` then reads `global.set[0] expected type externref,
 * found local.tee of type i32`, which is a module-level validation failure, not
 * a wrong answer. Measured on `S11.1.5_A2` reduced to its three load-bearing
 * checks (`var x = true` / `= function () {}` / `= this`).
 */
export function redeclarationWidenedLocalSlotType(
  ctx: CodegenContext,
  decl: ts.VariableDeclaration,
): ValType | undefined {
  if (!ts.isIdentifier(decl.name)) return undefined;
  if (ctx.moduleGlobals.get(decl.name.text) === undefined) return undefined;
  return redeclarationRetypesModuleBinding(ctx.oracle, decl) ? { kind: "externref" } : undefined;
}

/** Whether one exact declaration owns a slot this analysis widened. */
export function redeclarationRetypesModuleBinding(
  source: RedeclarationQuerySource,
  declaration: ts.VariableDeclaration,
): boolean {
  return (
    ts.isIdentifier(declaration.name) &&
    collectRedeclarationWidenedModuleVarNames(source, declaration.getSourceFile()).has(declaration.name.text)
  );
}
