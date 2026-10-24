// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * (#7106) The IR's generic `instanceof` over two dynamic carriers
 * (`dyn.instanceof`): one wrapper per module,
 * `__ir_dyn_instanceof(externref value, externref target) -> i32`, whose body is
 * EXACTLY the tail of legacy's `emitDynamicInstanceOf` on the host-free lanes:
 *
 *   1. `__instanceof_dynamic(value, target)`, the #2916 Slice B runtime
 *      §13.10.2 + §7.3.20, answering the 0 / 1 / 2 tri-state;
 *   2. `emitInstanceofThrowGuard`: 2 is the "Right-hand side of 'instanceof'
 *      is not callable" TypeError, 0 / 1 is the boolean.
 *
 * ## Exact legacy parity, deliberately including its residuals
 *
 * The IR admits a site only where legacy itself reaches that tail
 * ({@link irDynamicInstanceOfAtLegacyParity}): a dynamic-PARAMETER right
 * operand whose name no named arm of `compileHostInstanceOf` can claim. So the
 * IR answers what legacy answers, including the #2916 residuals. A runtime
 * non-callable target answers `false` instead of throwing (the "no wrong
 * throws" rule in `native-dynamic-instanceof.ts`). An Error-family target
 * answers through the chain walk, which the native error prototypes do not
 * fully link yet. Both diverge from the spec by design until the runtime
 * changes, and both change for legacy and the IR together.
 *
 * Built in `preregisterDynamicSupport`, before any Phase-3 body.
 */

import { ts } from "../ts-api.js";
import type { ValType } from "../ir/types.js";
import { isAmbientIntrinsicName } from "../ir/values/ambient-intrinsics.js";
import type { TypeFact } from "../checker/oracle.js";
import type { CodegenContext } from "./context/types.js";
import { ERROR_FAMILY_CTOR_NAMES, isBuiltinTypeName } from "./builtin-tags.js";
import { emitInstanceofThrowGuard } from "./expressions/identifiers.js";
import { helperFunctionContext, publishHelperFunction } from "./helpers/ir-helper-function.js";
import { noJsHost } from "./js-errors.js";
import { ensureNativeDynamicInstanceOf } from "./native-dynamic-instanceof.js";
import { identifierIsWrittenTo, moduleInstallsCallableHasInstance } from "./native-ordinary-instanceof.js";
import { flushLateImportShifts } from "./shared.js";

export const IR_DYN_INSTANCEOF_HELPER = "__ir_dyn_instanceof";

/** Per file: every name a NON-parameter declaration binds (functions, classes, variables, imports, …). */
const DECLARED_NAMES = new WeakMap<ts.SourceFile, ReadonlySet<string>>();

function declaredNonParameterNames(file: ts.SourceFile): ReadonlySet<string> {
  const cached = DECLARED_NAMES.get(file);
  if (cached) return cached;
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      (ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isClassDeclaration(node) ||
        ts.isClassExpression(node) ||
        ts.isVariableDeclaration(node) ||
        ts.isImportSpecifier(node) ||
        ts.isImportClause(node) ||
        ts.isNamespaceImport(node) ||
        ts.isImportEqualsDeclaration(node) ||
        ts.isEnumDeclaration(node) ||
        ts.isModuleDeclaration(node)) &&
      node.name !== undefined &&
      ts.isIdentifier(node.name)
    ) {
      names.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  DECLARED_NAMES.set(file, names);
  return names;
}

/**
 * May the IR lower `site` through `dyn.instanceof` and answer exactly as
 * legacy does? Two right-hand shapes qualify:
 * - a dynamic PARAMETER that legacy also sends through the generic runtime tail
 *   this wrapper reproduces (below);
 * - an Error-family builtin read off the realm, where legacy takes its
 *   name-based tag path ({@link errorIntrinsicTargetTakesTagPath}).
 *
 * For the parameter: legacy dispatches the right operand on its NAME first
 * (`resolveInstanceOfRHS`, the class / fnctor / builtin / alias arms of
 * `compileHostInstanceOf`). Those registries are keyed by the names that class,
 * function and variable declarations bind, and by builtin constructor names.
 * The selector runs before they are filled, so this predicate checks the
 * names themselves. A parameter whose name nothing else in the file declares,
 * that is no builtin constructor name, is never written, and is typed
 * `any`/`unknown` misses every named arm and the static non-callable throw.
 * Legacy then reaches `emitDynamicInstanceOf`. Its primitive-LHS fold answers
 * the same 0 the runtime gives a primitive value. A module that installs a
 * callable `@@hasInstance` takes legacy's operator entry instead, so it is
 * refused here.
 */
export function irDynamicInstanceOfAtLegacyParity(ctx: CodegenContext, site: ts.BinaryExpression): boolean {
  if (!noJsHost(ctx) || ctx.fast) return false;
  // `noJsHost` does not imply native-first: wasi with `strictNoHostImports: false`
  // keeps host-assisted providers, whose instanceof tail this wrapper does not copy.
  if (ctx.targetProfile.semanticProviders !== "native-first") return false;
  if (site.operatorToken.kind !== ts.SyntaxKind.InstanceOfKeyword || !ts.isIdentifier(site.right)) return false;
  const file = site.getSourceFile();
  if (moduleInstallsCallableHasInstance(file)) return false;
  return (
    parameterTargetRoutesGeneric(ctx, site.right, file) ||
    errorIntrinsicTargetTakesTagPath(ctx, site.right, site.left, file)
  );
}

/** The parameter half of {@link irDynamicInstanceOfAtLegacyParity}. */
function parameterTargetRoutesGeneric(ctx: CodegenContext, right: ts.Identifier, file: ts.SourceFile): boolean {
  const declaration = ctx.oracle.valueDeclarationOf(right);
  if (declaration === undefined || !ts.isParameter(declaration) || !ts.isIdentifier(declaration.name)) return false;
  const name = right.text;
  if (isBuiltinTypeName(name) || name === "Date") return false;
  if (declaredNonParameterNames(file).has(name)) return false;
  if (identifierIsWrittenTo(file, name)) return false;
  return isDynamicTypeFact(ctx.oracle.typeFactOf(right).kind);
}

function isDynamicTypeFact(kind: TypeFact["kind"]): boolean {
  return kind === "any" || kind === "unknown";
}

/**
 * (#7106) An Error-family constructor the IR may use as an `instanceof` target:
 * one with a native `$tag` (`ERROR_FAMILY_CTOR_NAMES`) that the IR can also read
 * off the realm (#7118's ambient-intrinsic value read). AggregateError and
 * SuppressedError fall out because that realm read does not admit them.
 */
function isInstanceOfErrorIntrinsic(name: string): boolean {
  return (ERROR_FAMILY_CTOR_NAMES as readonly string[]).includes(name) && isAmbientIntrinsicName(name);
}

/**
 * (#7106) `<any> instanceof TypeError` with the realm's own Error-family
 * constructor on the right. The IR reads that constructor off the realm
 * (#7118's `dyn.global_object`) and runs the generic operator. With #7120,
 * that operator answers an Error-family carrier from the value's `$tag`, the
 * set legacy's name-based path tests (#1473). This holds the site to exactly
 * where legacy takes that path:
 * - the name binds the lib declaration only, nothing in the file declares or
 *   writes it;
 * - the left operand is typed `any`/`unknown`, so none of
 *   `tryStaticInstanceOf`'s compile-time folds apply.
 * Whether the two paths agree row by row is measured, not assumed, in
 * `tests/issue-7106-ir-instanceof-error-intrinsic.test.ts`.
 */
function errorIntrinsicTargetTakesTagPath(
  ctx: CodegenContext,
  right: ts.Identifier,
  left: ts.Expression,
  file: ts.SourceFile,
): boolean {
  const name = right.text;
  if (!isInstanceOfErrorIntrinsic(name)) return false;
  if (ctx.oracle.valueDeclarationOf(right)?.getSourceFile().isDeclarationFile !== true) return false;
  if (declaredNonParameterNames(file).has(name) || identifierIsWrittenTo(file, name)) return false;
  return isDynamicTypeFact(ctx.oracle.typeFactOf(left).kind);
}

/**
 * Reserve (once per module) the wrapper `dyn.instanceof` calls. Returns the
 * function index, or undefined off the host-free lanes or on the fast
 * `$AnyValue` carrier (where a dynamic value is not an externref).
 */
export function ensureIrDynamicInstanceOfHelper(ctx: CodegenContext): number | undefined {
  if (!noJsHost(ctx) || ctx.fast) return undefined;
  const existing = ctx.funcMap.get(IR_DYN_INSTANCEOF_HELPER);
  if (existing !== undefined) return existing;
  const ordinary = ensureNativeDynamicInstanceOf(ctx);
  if (ordinary === undefined) return undefined;

  const externref: ValType = { kind: "externref" };
  const i32: ValType = { kind: "i32" };
  const helper = helperFunctionContext(
    IR_DYN_INSTANCEOF_HELPER,
    [
      { name: "value", type: externref },
      { name: "target", type: externref },
    ],
    i32,
  );
  helper.body.push({ op: "local.get", index: 0 }, { op: "local.get", index: 1 }, { op: "call", funcIdx: ordinary });
  emitInstanceofThrowGuard(ctx, helper);
  // The guard's TypeError may register late imports that shift baked indices.
  flushLateImportShifts(ctx, helper);
  return publishHelperFunction(ctx, helper);
}
