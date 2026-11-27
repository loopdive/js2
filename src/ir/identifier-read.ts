// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * (#7354 Ty) Which provider resolves an identifier read, in from-ast's resolution order. The ONE authority for
 * that order: the identifier read lowers by switching on the answer, and every other question about a read (the
 * `typeof` of a name nothing resolves) asks the same function, so the two cannot drift. Pure: it emits nothing.
 */
import ts from "typescript";
import type { TypeOracle } from "../checker/oracle.js";
import { isAmbientIntrinsicValueUse } from "../shared/ambient-intrinsics.js";
import { isGlobalUndefinedIdentifier } from "./analysis/operand-admissibility.js";
import { checkerOracleOf } from "./module-bindings.js";
import { errorConstructorId } from "./program/builtin-prototype-keys.js";
import { IrInvariantError } from "./outcomes.js";
import type { IrFromAstResolver } from "./from-ast.js";
import type { FunctionValueLoweringPlans } from "./function-object-lowering.js";

type ModuleBinding = NonNullable<ReturnType<NonNullable<IrFromAstResolver["resolveModuleBinding"]>>>;
type HostGlobal = NonNullable<ReturnType<NonNullable<IrFromAstResolver["getHostGlobalInfo"]>>>;
type TopLevelFunction = NonNullable<
  ReturnType<NonNullable<FunctionValueLoweringPlans["topLevelFunctionValues"]>["get"]>
>;

export type IdentifierRead<Binding> =
  | { readonly kind: "top-level-function"; readonly plan: TopLevelFunction }
  | { readonly kind: "scope"; readonly binding: Binding }
  | { readonly kind: "module-binding"; readonly binding: ModuleBinding }
  /** (#7354 G1) A built-in function object the realm holds, by catalog id ({@link realmIntrinsicRead}). */
  | { readonly kind: "realm-intrinsic"; readonly id: string }
  /** The global `undefined` as a value: the carrier's undefined (#7106 item 1). */
  | { readonly kind: "global-undefined" }
  /** `NaN` / `Infinity` (#7104, legacy's `identifiers.ts` arm). */
  | { readonly kind: "global-number"; readonly value: number }
  /** A host ambient global (`document`, …) through the declared-globals registry (#2856). */
  | { readonly kind: "host-global"; readonly global: HostGlobal; readonly certifiedDom: boolean }
  /** An ambient intrinsic as a value, read off the realm's global object (#7106). */
  | { readonly kind: "ambient-intrinsic" }
  /**
   * (#7354 Ty) A `typeof` operand no provider resolves, where the resolver states the name is absent from this
   * program's global environment: its `typeof` is "undefined" (§13.5.3, an unresolvable reference).
   */
  | { readonly kind: "absent-global" }
  | { readonly kind: "unresolved" };

interface IdentifierReadContext<Binding> extends FunctionValueLoweringPlans {
  readonly scope: ReadonlyMap<string, Binding>;
  readonly resolver?: IrFromAstResolver;
  readonly oracle?: TypeOracle;
  readonly checker?: ts.TypeChecker;
  readonly funcName: string;
}

/**
 * (#7439) The builder's `isGlobalUndefinedIdentifier`: its own scope, and the compile's oracle, else the checker's
 * (the Prepared path hands the builder a checker and no oracle). With neither, the answer is `unknown`.
 */
export function isGlobalUndefinedRead(
  id: ts.Identifier,
  cx: Pick<IdentifierReadContext<unknown>, "scope" | "oracle" | "checker">,
): boolean {
  const oracle = cx.oracle ?? (cx.checker ? checkerOracleOf(cx.checker) : undefined);
  return isGlobalUndefinedIdentifier(id, cx.scope, (node) => oracle?.undefinedReadOf(node) ?? "unknown");
}

export function classifyIdentifierRead<Binding>(
  expr: ts.Identifier,
  cx: IdentifierReadContext<Binding>,
): IdentifierRead<Binding> {
  const plan = cx.topLevelFunctionValues?.get(expr);
  if (plan) return { kind: "top-level-function", plan };
  const binding = cx.scope.get(expr.text);
  // Scope bindings take priority: a local named `document` or `undefined` shadows the global.
  if (binding !== undefined) return { kind: "scope", binding };
  const resolver = cx.resolver;
  const moduleBinding = resolver?.resolveModuleBinding?.(expr);
  if (moduleBinding) return { kind: "module-binding", binding: moduleBinding };
  const intrinsic = realmIntrinsicRead(expr, resolver);
  if (intrinsic !== undefined) return { kind: "realm-intrinsic", id: intrinsic };
  // Selector-admitted on the dynamic host-free lanes only.
  if (isGlobalUndefinedRead(expr, cx) && resolver?.stringIsExternref?.() !== true) return { kind: "global-undefined" };
  if (expr.text === "NaN" || expr.text === "Infinity")
    return { kind: "global-number", value: expr.text === "NaN" ? NaN : Infinity };
  const dom = resolver?.standaloneDomOperation?.(expr);
  const global = resolver?.getHostGlobalInfo?.(expr.text);
  if (dom?.kind === "global-get" && !global)
    throw new IrInvariantError(
      "selection-preparation-mismatch",
      "build",
      `ir/from-ast: certified DOM global ${expr.text} has no prepared import (${cx.funcName})`,
    );
  if (global)
    return {
      kind: "host-global",
      global,
      certifiedDom: dom?.kind === "global-get" && dom.identifier === expr && dom.importName === global.importName,
    };
  if (isAmbientIntrinsicValueUse(expr, (node) => resolver?.isLibOnlyBinding?.(node) === true, resolver))
    return { kind: "ambient-intrinsic" };
  return isTypeofOperand(expr) && resolver?.unresolvedNameIsAbsent?.(expr) === true
    ? { kind: "absent-global" }
    : { kind: "unresolved" };
}

/**
 * (#7354 G1) The catalog id of the built-in function object `expr` reads, on the lane where closures are function
 * objects: an Error constructor named by the unchanged global (`builtin-global-binding.ts`). Its value is the realm's
 * (`js.object.intrinsic`), so a read of a shadowed or written name never reaches here.
 */
export function realmIntrinsicRead(
  expr: ts.Identifier,
  resolver: Pick<IrFromAstResolver, "createsFunctionObjects" | "isPristineBuiltinGlobal"> | undefined,
): string | undefined {
  const id = errorConstructorId(expr.text);
  return id !== undefined &&
    resolver?.createsFunctionObjects?.() === true &&
    resolver.isPristineBuiltinGlobal?.(expr) === true
    ? id
    : undefined;
}

/** The build-time `typeof` answer for an absent global, from the same classification the read uses. */
export function absentGlobalTypeof<Binding>(
  expr: ts.Identifier,
  cx: IdentifierReadContext<Binding>,
): "undefined" | undefined {
  return classifyIdentifierRead(expr, cx).kind === "absent-global" ? "undefined" : undefined;
}

function isTypeofOperand(expr: ts.Identifier): boolean {
  let node: ts.Node = expr;
  while (ts.isParenthesizedExpression(node.parent)) node = node.parent;
  return ts.isTypeOfExpression(node.parent);
}

/**
 * Why a read of `identifier` has no binding. (#7354 Fa) A closure reading a local of its enclosing function that
 * is declared after the closure is created names that: the hoisted binding exists in JavaScript, but the closure
 * captures only what is bound where it is created.
 */
export function unboundIdentifierDetail(
  identifier: ts.Identifier,
  checker: ts.TypeChecker | undefined,
  funcName: string,
): string {
  const declaration = checker?.getSymbolAtLocation(identifier)?.valueDeclaration;
  const closure = ts.findAncestor(identifier, ts.isFunctionLike);
  const home = declaration && ts.isVariableDeclaration(declaration) && ts.findAncestor(declaration, ts.isFunctionLike);
  return closure && home && home !== closure && declaration.pos >= closure.end
    ? `closure ${funcName} reads "${identifier.text}", a local of its enclosing function declared after the closure is created`
    : `identifier "${identifier.text}" is not in scope in ${funcName}`;
}
